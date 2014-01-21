module.exports = Wire

var bitfield = require('bitfield')
var bncode = require('bncode')
var stream = require('stream')
var util = require('util')

var MESSAGE_PROTOCOL     = new Buffer('\u0013BitTorrent protocol')
var MESSAGE_KEEP_ALIVE   = new Buffer([0x00,0x00,0x00,0x00])
var MESSAGE_CHOKE        = new Buffer([0x00,0x00,0x00,0x01,0x00])
var MESSAGE_UNCHOKE      = new Buffer([0x00,0x00,0x00,0x01,0x01])
var MESSAGE_INTERESTED   = new Buffer([0x00,0x00,0x00,0x01,0x02])
var MESSAGE_UNINTERESTED = new Buffer([0x00,0x00,0x00,0x01,0x03])

var MESSAGE_RESERVED     = [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]
var MESSAGE_PORT         = [0x00,0x00,0x00,0x03,0x09,0x00,0x00]

function pull (requests, piece, offset, length) {
  for (var i = 0; i < requests.length; i++) {
    var req = requests[i]
    if (req.piece !== piece || req.offset !== offset || req.length !== length) continue
    if (i === 0) requests.shift()
    else requests.splice(i, 1)
    return req
  }
  return null
}

function Request (piece, offset, length, callback) {
  this.piece = piece
  this.offset = offset
  this.length = length
  this.callback = callback
  this.timeout = null
}

util.inherits(Wire, stream.Duplex)

function Wire () {
  var self = this
  if (!(this instanceof Wire)) return new Wire()

  stream.Duplex.call(this)

  self.choking = true
  self.interested = false
  self.peerChoking = true
  self.peerInterested = false
  self.peerPieces = []
  self.peerExtensions = {}

  self.uploaded = 0
  self.downloaded = 0

  self.requests = []
  self.peerRequests = []

  self._keepAlive = null
  self._finished = false

  self.on('finish', function () {
    self._finished = true
    self.push(null) // cannot be half open
    clearInterval(self._keepAlive)
    self._parse(Number.MAX_VALUE, function () {})
    while (self.peerRequests.length)
      self.peerRequests.pop()
    while (self.requests.length)
      self._callback(self.requests.shift(), new Error('wire is closed'), null)
  })

  var ontimeout = function () {
    self._callback(self.requests.shift(), new Error('request has timed out'), null)
    self.emit('timeout')
  }

  self._timeout = 0
  self._ontimeout = ontimeout

  var onmessagelength = function (buffer) {
    var length = buffer.readUInt32BE(0)
    if (length) return self._parse(length, onmessage)
    self._parse(4, onmessagelength)
    self.emit('keep-alive')
  }

  var onmessage = function (buffer) {
    self._parse(4, onmessagelength)
    switch (buffer[0]) {
      case 0:
        return self._onchoke()
      case 1:
        return self._onunchoke()
      case 2:
        return self._oninterested()
      case 3:
        return self._onuninterested()
      case 4:
        return self._onhave(buffer.readUInt32BE(1))
      case 5:
        return self._onbitfield(buffer.slice(1))
      case 6:
        return self._onrequest(buffer.readUInt32BE(1),
            buffer.readUInt32BE(5), buffer.readUInt32BE(9))
      case 7:
        return self._onpiece(buffer.readUInt32BE(1),
            buffer.readUInt32BE(5), buffer.slice(9))
      case 8:
        return self._oncancel(buffer.readUInt32BE(1),
            buffer.readUInt32BE(5), buffer.readUInt32BE(9))
      case 9:
        return self._onport(buffer.readUInt16BE(1))
      case 20:
        return self._onextended(bncode.decode(buffer))
    }
    self.emit('unknownmessage', buffer)
  }

  self._buffer = []
  self._bufferSize = 0
  self._parser = null
  self._parserSize = 0

  self._parse(1, function (buffer) {
    var pstrlen = buffer.readUInt8(0)
    self._parse(pstrlen + 48, function (handshake) {
      var protocol = handshake.slice(0, pstrlen)
      if (protocol.toString() !== 'BitTorrent protocol') {
        self.emit('error', 'Wire not speaking BitTorrent protocol: ', protocol)
        self.destroy()
        return
      }
      handshake = handshake.slice(pstrlen)
      self._onhandshake(handshake.slice(8, 28), handshake.slice(28, 48), {
        dht: !!(handshake[7] & 0x01), // see bep_0005
        extended: !!(handshake[5] & 0x10) // see bep_0010
      })
      self._parse(4, onmessagelength)
    })
  })
}

Wire.prototype.handshake = function (infoHash, peerId, extensions) {
  if (typeof infoHash === 'string')
    infoHash = new Buffer(infoHash, 'hex')
  if (typeof peerId === 'string')
    peerId = new Buffer(peerId)
  if (infoHash.length !== 20 || peerId.length !== 20)
    throw new Error('infoHash and peerId MUST have length 20')

  var reserved = new Buffer(MESSAGE_RESERVED)
  if (extensions && extensions.dht) reserved[7] |= 1
  reserved[5] |= 0x10 // enable extended message

  this._push(Buffer.concat([MESSAGE_PROTOCOL, reserved, infoHash, peerId]))
}

Wire.prototype.choke = function () {

  if (this.choking) return
  this.choking = true
  while (this.peerRequests.length) this.peerRequests.pop()
  this._push(MESSAGE_CHOKE)
}

Wire.prototype.unchoke = function () {
  if (!this.choking) return
  this.choking = false
  this._push(MESSAGE_UNCHOKE)
}

Wire.prototype.interested = function () {
  if (this.interested) return
  this.interested = true
  this._push(MESSAGE_INTERESTED)
}

Wire.prototype.uninterested = function () {
  if (!this.interested) return
  this.interested = false
  this._push(MESSAGE_UNINTERESTED)
}

Wire.prototype.have = function (i) {
  this._message(4, [i], null)
}

Wire.prototype.bitfield = function (bitfield) {
  if (bitfield.buffer) bitfield = bitfield.buffer // support bitfield objects
  this._message(5, [], bitfield)
}

Wire.prototype.request = function (i, offset, length, callback) {
  if (!callback) callback = function () {}
  if (this._finished)   return callback(new Error('wire is closed'))
  if (this.peerChoking) return callback(new Error('peer is choking'))
  this.requests.push(new Request(i, offset, length, callback))
  this._updateTimeout()
  this._message(6, [i, offset, length], null)
}

Wire.prototype.piece = function (i, offset, buffer) {
  this.uploaded += buffer.length
  this.emit('upload', buffer.length)
  this._message(7, [i, offset], buffer)
}

Wire.prototype.cancel = function (i, offset, length) {
  this._callback(pull(this.requests, i, offset, length), new Error('request was cancelled'), null)
  this._message(8, [i, offset, length], null)
}

Wire.prototype.extended = function (ext_number, msg) {
  var ext_id = new Buffer(1)
  ext_id.writeUInt8(ext_number, 0)
  this._message(20, [], Buffer.concat([ext_id, bncode.encode(msg)]))
}

Wire.prototype.port = function (port) {
  var message = new Buffer(MESSAGE_PORT)
  message.writeUInt16BE(port, 5)
  this._push(message)
}

Wire.prototype.setKeepAlive = function (bool) {
  clearInterval(this._keepAlive)
  if (bool === false) return
  this._keepAlive = setInterval(this._push.bind(this, MESSAGE_KEEP_ALIVE), 60000)
}

Wire.prototype.setTimeout = function (ms, fn) {
  if (this.requests.length) clearTimeout(this.requests[0].timeout)
  this._timeout = ms
  this._updateTimeout()
  if (fn) this.on('timeout', fn)
}

Wire.prototype.destroy = function () {
  this.emit('close')
  this.end()
}

// inbound

Wire.prototype._onhandshake = function (infoHash, peerId, extensions) {
  this.peerExtensions = extensions
  this.emit('handshake', infoHash, peerId, extensions)
}

Wire.prototype._oninterested = function () {
  this.peerInterested = true
  this.emit('interested')
}

Wire.prototype._onuninterested = function () {
  this.peerInterested = false
  this.emit('uninterested')
}

Wire.prototype._onchoke = function () {
  this.peerChoking = true
  this.emit('choke')
  while (this.requests.length)
    this._callback(this.requests.shift(), new Error('peer is choking'), null)
}

Wire.prototype._onunchoke = function () {
  this.peerChoking = false
  this.emit('unchoke')
}

Wire.prototype._onbitfield = function (buffer) {
  var pieces = bitfield(buffer)
  for (var i = 0; i < 8 * buffer.length; i++) {
    this.peerPieces[i] = pieces.get(i)
  }
  this.emit('bitfield', buffer)
}

Wire.prototype._onhave = function (i) {
  this.peerPieces[i] = true
  this.emit('have', i)
}

Wire.prototype._onrequest = function (i, offset, length) {
  if (this.choking) return

  var respond = function (err, buffer) {
    if (err || request !== pull(this.peerRequests, i, offset, length)) return
    this.piece(i, offset, buffer)
  }

  var request = new Request(i, offset, length, respond)
  this.peerRequests.push(request)
  this.emit('request', i, offset, length, respond)
}

Wire.prototype._oncancel = function (i, offset, length) {
  pull(this.peerRequests, i, offset, length)
  this.emit('cancel', i, offset, length)
}

Wire.prototype._onpiece = function (i, offset, buffer) {
  this._callback(pull(this.requests, i, offset, buffer.length), null, buffer)
  this.downloaded += buffer.length
  this.emit('download', buffer.length)
  this.emit('piece', i, offset, buffer)
}

Wire.prototype._onport = function (port) {
  this.emit('port', port)
}

Wire.prototype._onextended = function (ext) {
  this.emit('extended', ext)
}

// helpers and streams

Wire.prototype._callback = function (request, err, buffer) {
  if (!request) return
  if (request.timeout)
    clearTimeout(request.timeout)
  if (!this.peerChoking && !this._finished)
    this._updateTimeout()
  request.callback(err, buffer)
}

Wire.prototype._updateTimeout = function () {
  if (!this._timeout || !this.requests.length || this.requests[0].timeout)
    return
  this.requests[0].timeout = setTimeout(this._ontimeout, this._timeout)
}

Wire.prototype._message = function (id, numbers, data) {
  var dataLength = data ? data.length : 0
  var buffer = new Buffer(5 + 4 * numbers.length)

  buffer.writeUInt32BE(buffer.length + dataLength - 4, 0)
  buffer[4] = id
  for (var i = 0; i < numbers.length; i++) {
    buffer.writeUInt32BE(numbers[i], 5 + 4 * i)
  }

  this._push(buffer)
  if (data) this._push(data)
}

Wire.prototype._push = function (data) {
  if (this._finished) return
  this.push(data)
}

Wire.prototype._parse = function (size, parser) {
  this._parserSize = size
  this._parser = parser
}

/**
 * Duplex stream method. Called whenever the upstream has data for us.
 * @param  {Buffer|string} data
 * @param  {string}   encoding
 * @param  {function} cb
 */
Wire.prototype._write = function (data, encoding, cb) {
  this._bufferSize += data.length
  this._buffer.push(data)

  while (this._bufferSize >= this._parserSize) {
    var buffer = (this._buffer.length === 1)
      ? this._buffer[0]
      : Buffer.concat(this._buffer)
    this._bufferSize -= this._parserSize
    this._buffer = this._bufferSize
      ? [buffer.slice(this._parserSize)]
      : []
    this._parser(buffer.slice(0, this._parserSize))
  }

  cb(null) // Signal that we're ready for more data
}

/**
 * Duplex stream method. Called whenever the downstream wants data.
 * No-op since we'll just push data whenever we get it and extra data will be
 * buffered in memory.
 */
Wire.prototype._read = function () {}
