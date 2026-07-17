import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// ../../node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value2 = params[key];
            if (value2.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value2 = value2[0];
            if (key === "client_max_window_bits") {
              if (value2 !== true) {
                const num = +value2;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value2}`
                  );
                }
                value2 = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value2;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
              value2 = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value2 !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value2;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value2) {
      return hasBlob && typeof value2 === "object" && typeof value2.arrayBuffer === "function" && typeof value2.type === "string" && typeof value2.stream === "function" && (value2[Symbol.toStringTag] === "Blob" || value2[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// ../../node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value2 = header.slice(start, end);
            if (mustUnescape) {
              value2 = value2.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value2);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// ../../node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes3, createHash } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes3(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value2] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value2;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// ../../node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// ../../node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value2 = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value2}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/service.ts
import { createCipheriv, createDecipheriv, randomBytes as randomBytes2, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// src/audio-bridge.ts
import { randomBytes, timingSafeEqual } from "node:crypto";

// ../../node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// src/audio-bridge.ts
var AUDIO_SAMPLE_RATE = 16e3;
var INT16_FULL_SCALE = 32768;
var REPORT_INTERVAL_MS = 2e3;
function dbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}
function formatDb(amplitude) {
  const value2 = dbfs(amplitude);
  return value2 === -Infinity ? "-inf" : value2.toFixed(1);
}
function tokensMatch(expected, received) {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
function isLoopbackAddress(address) {
  const value2 = String(address ?? "");
  return value2 === "127.0.0.1" || value2 === "::1" || value2 === "::ffff:127.0.0.1";
}
var AudioBridge = class {
  constructor(log = console, options = {}) {
    this.log = log;
    this.reportIntervalMs = options.reportIntervalMs ?? REPORT_INTERVAL_MS;
  }
  wss = null;
  taps = /* @__PURE__ */ new Map();
  port = 0;
  reportIntervalMs;
  async start() {
    if (this.wss) return this.port;
    this.wss = new import_websocket_server.default({ host: "127.0.0.1", port: 0, maxPayload: 1 << 20 });
    await new Promise((resolve, reject) => {
      this.wss.once("listening", resolve);
      this.wss.once("error", reject);
    });
    this.port = this.wss.address().port;
    this.wss.on("connection", (socket, req) => this.accept(socket, req));
    this.log?.info?.(`[webex-auto-join] audio bridge listening on 127.0.0.1:${this.port}`);
    return this.port;
  }
  // Returns the credentials the runner needs, or undefined when the bridge is off.
  // Each runner load mints a fresh token; a relaunch supersedes the previous tap.
  register(sessionId) {
    if (!this.wss) return void 0;
    this.taps.get(sessionId)?.socket?.close?.(1e3, "superseded");
    const token = randomBytes(24).toString("base64url");
    this.taps.set(sessionId, {
      sessionId,
      token,
      totalSamples: 0,
      sumSquares: 0,
      windowSamples: 0,
      peak: 0,
      reportedAt: Date.now()
    });
    return { port: this.port, token, sampleRate: AUDIO_SAMPLE_RATE };
  }
  unregister(sessionId) {
    const tap = this.taps.get(sessionId);
    if (!tap) return;
    if (tap.totalSamples > 0) {
      const seconds = (tap.totalSamples / (tap.sampleRate ?? AUDIO_SAMPLE_RATE)).toFixed(1);
      this.log?.info?.(`[webex-auto-join] audio tap closed session=${sessionId} captured=${seconds}s`);
    }
    tap.socket?.close?.(1e3, "session_closed");
    this.taps.delete(sessionId);
  }
  async stop() {
    for (const sessionId of [...this.taps.keys()]) this.unregister(sessionId);
    if (!this.wss) return;
    const server = this.wss;
    this.wss = null;
    this.port = 0;
    await new Promise((resolve) => server.close(() => resolve()));
  }
  accept(socket, req) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return socket.close(1008, "loopback_only");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sessionId = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const tap = this.taps.get(sessionId);
    if (!tap || !token || !tokensMatch(tap.token, token)) return socket.close(1008, "unauthorized");
    tap.socket?.close?.(1e3, "superseded");
    tap.socket = socket;
    socket.on("message", (data, isBinary) => this.consume(tap, data, isBinary));
    socket.on("close", () => {
      if (tap.socket === socket) tap.socket = void 0;
    });
    socket.on("error", (error) => this.log?.warn?.(`[webex-auto-join] audio tap socket error session=${sessionId}: ${error?.message ?? error}`));
  }
  consume(tap, data, isBinary) {
    if (!isBinary) return this.handshake(tap, data);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const samples = Math.floor(buffer.length / 2);
    for (let i = 0; i < samples; i++) {
      const amplitude = Math.abs(buffer.readInt16LE(i * 2)) / INT16_FULL_SCALE;
      tap.sumSquares += amplitude * amplitude;
      if (amplitude > tap.peak) tap.peak = amplitude;
    }
    tap.totalSamples += samples;
    tap.windowSamples += samples;
    this.report(tap);
  }
  handshake(tap, data) {
    let hello;
    try {
      hello = JSON.parse(String(data));
    } catch {
      return;
    }
    if (hello?.type !== "hello") return;
    tap.sampleRate = Number(hello.sampleRate) || void 0;
    const rateNote = tap.sampleRate === AUDIO_SAMPLE_RATE ? "" : ` (expected ${AUDIO_SAMPLE_RATE})`;
    this.log?.info?.(
      `[webex-auto-join] audio tap open session=${tap.sessionId} rate=${tap.sampleRate}${rateNote} encoding=${hello.encoding} channels=${hello.channels}`
    );
  }
  report(tap) {
    const now = Date.now();
    if (now - tap.reportedAt < this.reportIntervalMs || tap.windowSamples === 0) return;
    const rms = Math.sqrt(tap.sumSquares / tap.windowSamples);
    const seconds = (tap.totalSamples / (tap.sampleRate ?? AUDIO_SAMPLE_RATE)).toFixed(1);
    this.log?.info?.(
      `[webex-auto-join] audio tap session=${tap.sessionId} captured=${seconds}s rms=${formatDb(rms)}dBFS peak=${formatDb(tap.peak)}dBFS`
    );
    tap.sumSquares = 0;
    tap.windowSamples = 0;
    tap.peak = 0;
    tap.reportedAt = now;
  }
};

// src/discovery.ts
function value(input) {
  const normalized = String(input ?? "").trim();
  return normalized && !normalized.startsWith("${") ? normalized : "";
}
function selectDestination(meeting) {
  const webLink = value(meeting?.webLink);
  if (webLink) return { destination: webLink, kind: "web_link" };
  const sipAddress = value(meeting?.sipAddress);
  if (sipAddress) return { destination: sipAddress, kind: "sip_address" };
  const meetingNumber = value(meeting?.meetingNumber);
  if (meetingNumber) return { destination: meetingNumber, kind: "meeting_number" };
  const meetingId = value(meeting?.id);
  if (meetingId) return { destination: meetingId, kind: "meeting_id" };
  return null;
}
function createDiscoveredInvitation(meeting, roomId) {
  const meetingId = value(meeting?.id);
  const webLink = value(meeting?.webLink);
  const selected = selectDestination(meeting);
  if (!roomId || !selected) return null;
  return {
    destination: selected.destination,
    destinationKind: selected.kind,
    ...webLink ? { joinLink: webLink } : {},
    ...value(meeting?.password) ? { password: value(meeting.password) } : {},
    ...meetingId ? { meetingId } : {},
    ...value(meeting?.meetingNumber) ? { meetingNumber: value(meeting.meetingNumber) } : {},
    discoveredAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function isJoinableMeeting(meeting) {
  return value(meeting?.meetingType) === "meeting" && ["lobby", "inProgress"].includes(value(meeting?.state));
}
function isTerminalMeeting(meeting) {
  return value(meeting?.meetingType) === "meeting" && value(meeting?.state) === "ended";
}

// src/webex.ts
import { createHmac, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var WEBEX_API = "https://webexapis.com/v1";
var MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
var WebexApiError = class extends Error {
  status;
  body;
  constructor(method, pathname, status, body) {
    super(`Webex ${method} ${pathname} failed (${status})`);
    this.name = "WebexApiError";
    this.status = status;
    this.body = body;
  }
};
async function webexRequest(token, pathname, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(pathname.startsWith("https://") ? pathname : `${WEBEX_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.body === void 0 ? {} : { "Content-Type": "application/json" }
    },
    ...init.body === void 0 ? {} : { body: JSON.stringify(init.body) }
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new WebexApiError(method, pathname, response.status, text);
  let data = {};
  if (text) data = JSON.parse(text);
  return { data, headers: response.headers };
}
async function webexList(token, pathname) {
  const items = [];
  let next = pathname;
  while (next) {
    const result = await webexRequest(token, next);
    items.push(...Array.isArray(result.data?.items) ? result.data.items : []);
    const link = result.headers?.get?.("link") ?? "";
    const match = String(link).match(/<([^>]+)>;\s*rel="next"/i);
    next = match?.[1];
    if (next && !next.startsWith(`${WEBEX_API}/`)) throw new Error("Webex pagination returned an unexpected origin");
  }
  return items;
}
async function ensureOwnedWebhooks(token, targetUrl, secret, specs) {
  const existing = await webexList(token, "/webhooks?max=100");
  for (const spec of specs) {
    const matches = existing.filter((item) => item?.name === spec.name);
    const keeper = matches.find(
      (item) => item?.targetUrl === targetUrl && item?.resource === spec.resource && item?.event === spec.event && item?.status !== "disabled"
    );
    for (const item of matches) {
      if (item === keeper) continue;
      await webexRequest(token, `/webhooks/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    }
    if (!keeper) {
      await webexRequest(token, "/webhooks", {
        method: "POST",
        body: { ...spec, targetUrl, ...secret ? { secret } : {} }
      });
    }
  }
}
function verifyWebhookSignature(secret, rawBody, signature) {
  if (!secret || typeof signature !== "string" || !/^[a-f\d]{40}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac("sha1", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(signature.toLowerCase());
  return expected.length === received.length && timingSafeEqual2(expected, received);
}
async function readRawBody(req, maxBytes = MAX_WEBHOOK_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error("webhook_body_too_large");
      error.code = "webhook_body_too_large";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/notifications.ts
var WebexMessageDelivery = class {
  constructor(botToken) {
    this.botToken = botToken;
  }
  async send(roomId, markdown) {
    const response = await fetch(`${WEBEX_API}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, markdown })
    });
    if (!response.ok) throw new Error(`Webex status send failed (${response.status})`);
  }
};

// src/service.ts
var ACTIVE_STATES = /* @__PURE__ */ new Set([
  "preparing",
  "ready_for_browser",
  "joining",
  "waiting_for_admission",
  "joined",
  "leaving",
  "interrupted",
  "recovering"
]);
function emptyState() {
  return { version: 2, sessions: {}, rooms: {}, schedules: {}, pending: {}, dismissed: {}, notifications: {} };
}
var DISMISSAL_TTL_MS = 12 * 60 * 6e4;
function meetingIdRoot(id) {
  return id.replace(/_I_\d+$/, "").replace(/_\d{8}T\d{6}Z$/, "");
}
function sameMeetingId(a, b) {
  return Boolean(a && b && meetingIdRoot(a) === meetingIdRoot(b));
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function configured(value2) {
  const normalized = String(value2 ?? "").trim();
  return normalized && !normalized.startsWith("${") ? normalized : "";
}
function safeErrorCode(error) {
  const controlCode = String(error?.controlCode ?? "");
  if (controlCode === "ACT_TARGET_ID_MISMATCH") return "browser_target_id_mismatch";
  if (controlCode === "ACT_INVALID_REQUEST" || controlCode === "ACT_KIND_REQUIRED") return "browser_action_invalid";
  if (controlCode === "ACT_EXISTING_SESSION_UNSUPPORTED") return "browser_action_unsupported";
  const explicitCode = String(error?.code ?? "");
  if (explicitCode === "browser_control_unavailable" || explicitCode === "browser_control_unauthorized") return explicitCode;
  if (explicitCode === "webhook_body_too_large") return explicitCode;
  const status = Number(error?.status ?? 0);
  if (status === 401 || status === 403) return "webex_authorization_failed";
  if (status === 400) return "webex_request_invalid";
  if (status === 404) return "webex_resource_not_found";
  if (status === 409) return "webex_conflict";
  if (status === 429) return "webex_rate_limited";
  if (status >= 500) return "webex_unavailable";
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (message.includes("config is missing")) return "configuration_missing";
  if (message.includes("could not be decrypted")) return "state_decryption_failed";
  if (message.includes("encryption key")) return "encryption_key_invalid";
  if (message.includes("identities must be distinct")) return "identity_conflict";
  if (message.includes("identity does not match")) return "identity_mismatch";
  if (message.includes("captcha")) return "captcha_required";
  if (message.includes("password")) return "meeting_password_rejected";
  if (message.includes("token") || message.includes("oauth")) return "oauth_unavailable";
  if (message.includes("capacity")) return "capacity_reached";
  if (message.includes("history")) return "meeting_history_unavailable";
  return "meeting_join_failed";
}
function safePublicFailureCode(code) {
  const normalized = String(code ?? "").trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(normalized) ? normalized : "meeting_join_failed";
}
function safePublicFailureDetail(detail) {
  return String(detail ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/\b(access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/gi, "$1=[redacted]").replace(/(^|[^A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,}(?=$|[^A-Za-z0-9_+/=-])/g, "$1[redacted-value]").replace(/[`*~<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 2e3);
}
function safeErrorDetail(error, stage) {
  const item = error ?? {};
  const controlCode = configured(item?.controlCode);
  const status = Number(item?.status ?? 0);
  const message = configured(item?.controlError) || configured(item?.message) || String(error ?? "");
  const body = typeof item?.body === "string" ? item.body : item?.body ? (() => {
    try {
      return JSON.stringify(item.body);
    } catch {
      return "";
    }
  })() : "";
  return safePublicFailureDetail([
    `stage=${stage}`,
    ...item?.name ? [`name=${item.name}`] : [],
    ...controlCode ? [`control_code=${controlCode}`] : [],
    ...status ? [`status=${status}`] : [],
    ...message ? [`message=${message}`] : [],
    ...body ? [`body=${body}`] : []
  ].join("; "));
}
function browserActionFailure(error) {
  const controlCode = String(error?.controlCode ?? "");
  const message = String(error?.controlError ?? error?.message ?? error ?? "").toLowerCase();
  if (controlCode === "ACT_TARGET_ID_MISMATCH") return { error_code: "browser_target_id_mismatch", retryable: false };
  if (controlCode === "ACT_INVALID_REQUEST" || controlCode === "ACT_KIND_REQUIRED") return { error_code: "browser_action_invalid", retryable: false };
  if (controlCode === "ACT_EXISTING_SESSION_UNSUPPORTED") return { error_code: "browser_action_unsupported", retryable: false };
  if (message.includes("unknown ref") || message.includes("stale") || message.includes("tab not found")) {
    return { error_code: "meeting_runner_snapshot_stale", retryable: true };
  }
  const code = safeErrorCode(error);
  return { error_code: code === "browser_control_unauthorized" ? code : "meeting_runner_action_failed", retryable: code !== "browser_control_unauthorized" };
}
function snapshotRefs(snapshot) {
  const refs = /* @__PURE__ */ new Set();
  if (snapshot?.refs && typeof snapshot.refs === "object") {
    for (const ref of Object.keys(snapshot.refs)) if (/^(?:\d+|e\d+|ax\d+)$/.test(ref)) refs.add(ref);
  }
  const text = String(snapshot?.snapshot ?? snapshot?.nodes ?? "");
  for (const match of text.matchAll(/(?:\[ref=|aria-ref=["'])(\d+|e\d+|ax\d+)(?:\]|["'])/g)) refs.add(match[1]);
  return [...refs];
}
function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function parseCookies(raw) {
  return Object.fromEntries(String(raw ?? "").split(";").map((part) => part.trim().split("=")).filter(([key, value2]) => key && value2));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function createInvitation(joinLink, password) {
  let parsed;
  try {
    parsed = new URL(String(joinLink ?? "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !(parsed.hostname === "webex.com" || parsed.hostname.endsWith(".webex.com"))) return null;
  const normalizedPassword = String(password ?? "").trim();
  if (!normalizedPassword) return null;
  return { destination: parsed.toString(), destinationKind: "web_link", joinLink: parsed.toString(), password: normalizedPassword, discoveredAt: nowIso() };
}
async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}
var EncryptedState = class {
  key;
  statePath;
  constructor(rawKey, statePath) {
    const key = rawKey ? Buffer.from(rawKey, "base64") : Buffer.alloc(0);
    if (key.length !== 32) throw new Error("encryption key must be a base64-encoded 32-byte key");
    this.key = key;
    this.statePath = statePath;
  }
  async load() {
    try {
      const envelope = JSON.parse(await readFile(this.statePath, "utf8"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
      const parsed = JSON.parse(plain.toString("utf8"));
      return {
        version: 2,
        sessions: parsed.sessions ?? {},
        rooms: parsed.rooms ?? {},
        schedules: parsed.schedules ?? {},
        pending: parsed.pending ?? {},
        dismissed: parsed.dismissed ?? {},
        notifications: parsed.notifications ?? {},
        token: parsed.token
      };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw new Error("auto-join state could not be decrypted; refusing to use stored credentials");
    }
  }
  async save(state) {
    const iv = randomBytes2(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      v: 2,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    });
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.${process.pid}.${randomBytes2(4).toString("hex")}.tmp`;
    await writeFile(temp, envelope, { mode: 384 });
    await rename(temp, this.statePath);
  }
};
var BrowserControlError = class extends Error {
  code;
  status;
  controlCode;
  controlError;
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BrowserControlError";
    this.code = code;
    Object.assign(this, details);
  }
};
var BrowserControl = class {
  constructor(profile) {
    this.profile = profile;
  }
  get baseUrl() {
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789) + 2;
    return `http://127.0.0.1:${port}`;
  }
  async request(method, pathname, body) {
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!token) throw new BrowserControlError("OPENCLAW_GATEWAY_TOKEN is required for browser control", "browser_control_unauthorized");
    let response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}${pathname.includes("?") ? "&" : "?"}profile=${encodeURIComponent(this.profile)}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...body === void 0 ? {} : { "Content-Type": "application/json" } },
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      });
    } catch (cause) {
      throw new BrowserControlError("OpenClaw browser control is unreachable", "browser_control_unavailable", { controlError: String(cause?.message ?? cause ?? "") });
    }
    if (!response.ok) {
      const responseBody = await response.json().catch(() => ({}));
      throw new BrowserControlError(`Browser control ${method} ${pathname} failed (${response.status})`, response.status === 401 || response.status === 403 ? "browser_control_unauthorized" : "browser_control_unavailable", {
        status: response.status,
        controlCode: typeof responseBody?.code === "string" ? responseBody.code : void 0,
        controlError: typeof responseBody?.error === "string" ? responseBody.error : void 0
      });
    }
    return response.json().catch(() => ({}));
  }
  start() {
    return this.request("POST", "/start?headless=true");
  }
  async open(url, label) {
    const result = await this.request("POST", "/tabs/open", { url, label });
    return result.suggestedTargetId ?? result.targetId ?? result.id;
  }
  async close(tabId) {
    if (tabId) await this.request("DELETE", `/tabs/${encodeURIComponent(tabId)}`).catch(() => void 0);
  }
  snapshot(tabId) {
    return this.request("GET", `/snapshot?targetId=${encodeURIComponent(tabId)}&format=ai`);
  }
  click(targetId, ref) {
    return this.request("POST", "/act", { kind: "click", targetId, ref });
  }
};
var MeetingJoinService = class {
  constructor(runtime, config, log = console, assets = {}) {
    this.runtime = runtime;
    this.log = log;
    this.assets = assets;
    this.cfg = {
      botToken: configured(config?.botToken) || configured(process.env.WEBEX_BOT_TOKEN),
      webhookUrl: configured(config?.webhookUrl) || configured(process.env.WEBEX_AUTO_JOIN_WEBHOOK_URL),
      webhookSecret: configured(config?.webhookSecret) || configured(process.env.WEBEX_WEBHOOK_SECRET),
      attendeeClientId: configured(config?.attendeeClientId) || configured(process.env.MEETING_JOIN_CLIENT_ID),
      attendeeClientSecret: configured(config?.attendeeClientSecret) || configured(process.env.MEETING_JOIN_CLIENT_SECRET),
      attendeeRefreshToken: configured(config?.attendeeRefreshToken) || configured(process.env.MEETING_JOIN_REFRESH_TOKEN),
      expectedAttendeeEmail: (configured(config?.expectedAttendeeEmail) || configured(process.env.MEETING_JOIN_EXPECTED_EMAIL)).toLowerCase(),
      encryptionKey: configured(config?.encryptionKey) || configured(process.env.MEETING_JOIN_ENCRYPTION_KEY),
      maxConcurrentMeetings: config?.maxConcurrentMeetings ?? 4,
      browserProfile: config?.browserProfile ?? "webex-auto-join",
      requireBrowserReview: config?.requireBrowserReview ?? false,
      recoveryMaxAttempts: config?.recoveryMaxAttempts ?? 5,
      recoveryBaseDelayMs: config?.recoveryBaseDelayMs ?? 1e3,
      meetingReconcileIntervalMs: (config?.meetingReconcileIntervalSeconds ?? 60) * 1e3,
      membershipReconcileIntervalMs: (config?.membershipReconcileIntervalSeconds ?? 300) * 1e3,
      schedulingHorizonDays: config?.schedulingHorizonDays ?? 30,
      scheduledStartGraceMinutes: config?.scheduledStartGraceMinutes ?? 30,
      notificationMode: config?.notificationMode ?? "join-and-failure",
      audioTap: config?.audioTap ?? true
    };
    this.browser = new BrowserControl(this.cfg.browserProfile);
    this.messages = new WebexMessageDelivery(this.cfg.botToken);
    this.audio = new AudioBridge(this.log);
  }
  state = emptyState();
  store = null;
  runnerNonces = /* @__PURE__ */ new Map();
  runnerCookies = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  scheduleTimers = /* @__PURE__ */ new Map();
  enabled = false;
  stopped = false;
  startTask = null;
  heartbeatTimer = null;
  membershipTimer = null;
  meetingTimer = null;
  startupRetryTimer = null;
  startupAttempts = 0;
  startupErrorCode;
  botId = "";
  attendeeId = "";
  cfg;
  browser;
  messages;
  audio;
  async start() {
    if (this.enabled) return;
    if (this.startTask) return this.startTask;
    this.stopped = false;
    const task = this.startInternal();
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = null;
    }
  }
  async startInternal() {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
    const statePath = path.join(stateDir, "webex-auto-join-state.enc");
    try {
      this.requireAutomationConfig();
      this.store = new EncryptedState(this.cfg.encryptionKey, statePath);
      const newStateExists = await fileExists(statePath);
      this.state = await this.store.load();
      if (!newStateExists) await this.importLegacyToken(path.join(stateDir, "meeting-join-state.enc"));
      const attendeeToken = await this.getAccessToken();
      const [bot, attendee] = await Promise.all([
        webexRequest(this.cfg.botToken, "/people/me").then((result) => result.data),
        webexRequest(attendeeToken, "/people/me").then((result) => result.data)
      ]);
      this.botId = configured(bot?.id);
      this.attendeeId = configured(attendee?.id);
      const attendeeEmails = [attendee?.email, ...Array.isArray(attendee?.emails) ? attendee.emails : []].map((email) => String(email ?? "").toLowerCase()).filter(Boolean);
      if (!this.botId || !this.attendeeId || this.botId === this.attendeeId) throw new Error("Webex bot and attendee identities must be distinct");
      if (!attendeeEmails.includes(this.cfg.expectedAttendeeEmail)) throw new Error("configured attendee identity does not match OAuth token");
      await this.ensureWebhooks(attendeeToken);
      if (this.cfg.audioTap) await this.audio.start().catch((error) => this.logFailure("audio bridge startup", error));
      this.enabled = true;
      await this.reconcileMemberships();
      await this.reconcileMeetings();
      this.rebuildScheduleTimers();
      await this.recoverActiveSessions();
      this.heartbeatTimer = setInterval(() => this.checkHeartbeats().catch(() => void 0), 15e3);
      this.membershipTimer = setInterval(() => this.reconcileMemberships().catch((error) => this.logFailure("membership reconciliation", error)), this.cfg.membershipReconcileIntervalMs);
      this.meetingTimer = setInterval(() => this.reconcileMeetings().catch((error) => this.logFailure("meeting reconciliation", error)), this.cfg.meetingReconcileIntervalMs);
      this.heartbeatTimer.unref?.();
      this.membershipTimer.unref?.();
      this.meetingTimer.unref?.();
      this.startupAttempts = 0;
      this.startupErrorCode = void 0;
      if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = null;
      this.log?.info?.(`[webex-auto-join] ready: ${Object.values(this.state.rooms).filter((room) => room.covered).length} covered spaces`);
    } catch (error) {
      this.enabled = false;
      this.startupErrorCode = safeErrorCode(error);
      this.logFailure("startup disabled", error);
      this.scheduleStartupRetry();
    }
  }
  scheduleStartupRetry() {
    if (this.stopped || this.startupRetryTimer) return;
    const delayMs = Math.min(6e4, this.cfg.recoveryBaseDelayMs * 2 ** Math.min(this.startupAttempts, 6));
    this.startupAttempts += 1;
    this.log?.info?.(`[webex-auto-join] retrying startup in ${delayMs}ms`);
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = null;
      this.start().catch((error) => this.logFailure("startup retry", error));
    }, delayMs);
    this.startupRetryTimer.unref?.();
  }
  async stop() {
    this.stopped = true;
    this.enabled = false;
    for (const timer of [this.heartbeatTimer, this.membershipTimer, this.meetingTimer]) if (timer) clearInterval(timer);
    this.heartbeatTimer = null;
    this.membershipTimer = null;
    this.meetingTimer = null;
    if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
    this.startupRetryTimer = null;
    for (const timer of this.scheduleTimers.values()) clearTimeout(timer);
    this.scheduleTimers.clear();
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state)) continue;
      await this.browser.close(session.tabId);
      session.tabId = void 0;
      session.state = session.state === "leaving" ? "left" : "interrupted";
      session.updatedAt = nowIso();
    }
    this.runnerNonces.clear();
    this.runnerCookies.clear();
    await this.audio.stop().catch(() => void 0);
    await this.persist().catch(() => void 0);
  }
  requireAutomationConfig() {
    for (const key of ["botToken", "webhookUrl", "webhookSecret", "attendeeClientId", "attendeeClientSecret", "attendeeRefreshToken", "expectedAttendeeEmail", "encryptionKey"]) {
      if (!this.cfg[key]) throw new Error(`webex-auto-join config is missing ${key}`);
    }
    const url = new URL(this.cfg.webhookUrl);
    if (url.protocol !== "https:" || url.pathname !== "/webhooks/webex-auto-join" || url.search || url.hash || url.username || url.password) {
      throw new Error("webhookUrl must be an HTTPS origin plus /webhooks/webex-auto-join");
    }
  }
  async importLegacyToken(legacyPath) {
    if (!await fileExists(legacyPath)) return;
    const legacy = await new EncryptedState(this.cfg.encryptionKey, legacyPath).load();
    if (legacy.token) {
      this.state.token = legacy.token;
      await this.persist();
      this.log?.info?.("[webex-auto-join] imported rotating OAuth token from legacy meeting-join state");
    }
  }
  async ensureWebhooks(attendeeToken) {
    await ensureOwnedWebhooks(this.cfg.botToken, this.cfg.webhookUrl, this.cfg.webhookSecret, [
      { name: "OpenClaw Webex Auto Join Membership Created", resource: "memberships", event: "created" },
      { name: "OpenClaw Webex Auto Join Membership Deleted", resource: "memberships", event: "deleted" }
    ]);
    await ensureOwnedWebhooks(attendeeToken, this.cfg.webhookUrl, this.cfg.webhookSecret, [
      { name: "OpenClaw Webex Auto Join Meeting Created", resource: "meetings", event: "created" },
      { name: "OpenClaw Webex Auto Join Meeting Updated", resource: "meetings", event: "updated" },
      { name: "OpenClaw Webex Auto Join Meeting Deleted", resource: "meetings", event: "deleted" },
      { name: "OpenClaw Webex Auto Join Meeting Started", resource: "meetings", event: "started" },
      { name: "OpenClaw Webex Auto Join Meeting Ended", resource: "meetings", event: "ended" }
    ]);
  }
  async handleWebhookRoute(req, res) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }
    let raw;
    try {
      raw = await readRawBody(req);
    } catch (error) {
      res.statusCode = safeErrorCode(error) === "webhook_body_too_large" ? 413 : 400;
      res.end();
      return true;
    }
    if (!verifyWebhookSignature(this.cfg.webhookSecret, raw, req.headers?.["x-spark-signature"])) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.statusCode = 400;
      res.end("Bad Request");
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
    const key = `${payload?.resource ?? "unknown"}:${payload?.data?.roomId ?? payload?.data?.id ?? "unknown"}`;
    this.enqueue(key, () => this.dispatchWebhook(payload));
    return true;
  }
  enqueue(key, task) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(task).catch((error) => this.logFailure(`webhook ${key}`, error)).finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
    this.queues.set(key, current);
  }
  async dispatchWebhook(payload) {
    if (!this.enabled) return;
    if (payload?.resource === "memberships") return this.handleMembershipWebhook(payload);
    if (payload?.resource !== "meetings") return;
    const meetingId = configured(payload?.data?.id);
    if (payload?.event === "deleted") {
      await this.removeMeeting(meetingId, configured(payload?.data?.roomId));
      return;
    }
    if (payload?.data?.meetingType || payload?.data?.state) await this.processMeeting(payload.data);
    if (meetingId) {
      const meeting = await this.fetchMeetingWithRetry(meetingId);
      if (meeting) await this.processMeeting(meeting);
    }
  }
  async handleMembershipWebhook(payload) {
    const personId = configured(payload?.data?.personId);
    const roomId = configured(payload?.data?.roomId);
    if (!roomId) return;
    if (personId === this.botId) {
      if (payload.event === "deleted") await this.removeManagedRoom(roomId);
      else await this.ensureRoomCovered(roomId);
    } else if (personId === this.attendeeId && payload.event === "deleted" && this.state.rooms[roomId]) {
      await this.ensureRoomCovered(roomId);
    }
  }
  async reconcileMemberships() {
    if (!this.enabled) return;
    const rooms = await webexList(this.cfg.botToken, "/rooms?type=group&max=1000");
    const seen = /* @__PURE__ */ new Set();
    for (const room of rooms) {
      const roomId = configured(room?.id);
      if (!roomId || room?.type === "direct") continue;
      seen.add(roomId);
      await this.ensureRoomCovered(roomId, room);
    }
    for (const roomId of Object.keys(this.state.rooms)) if (!seen.has(roomId)) await this.removeManagedRoom(roomId);
  }
  async ensureRoomCovered(roomId, suppliedRoom) {
    let room = suppliedRoom;
    if (!room) {
      try {
        room = (await webexRequest(this.cfg.botToken, `/rooms/${encodeURIComponent(roomId)}`)).data;
      } catch (error) {
        this.logFailure(`room lookup ${roomId}`, error);
        return;
      }
    }
    if (room?.type === "direct") return;
    const existingState = this.state.rooms[roomId];
    try {
      const query = `/memberships?roomId=${encodeURIComponent(roomId)}&personEmail=${encodeURIComponent(this.cfg.expectedAttendeeEmail)}&max=100`;
      const memberships = await webexList(this.cfg.botToken, query);
      let membership = memberships[0];
      let provenance = existingState?.membershipProvenance === "created" ? "created" : "existing";
      if (!membership) {
        membership = (await webexRequest(this.cfg.botToken, "/memberships", {
          method: "POST",
          body: { roomId, personEmail: this.cfg.expectedAttendeeEmail, isModerator: false }
        })).data;
        provenance = "created";
      }
      this.state.rooms[roomId] = {
        roomId,
        title: configured(room?.title) || existingState?.title,
        covered: true,
        membershipId: configured(membership?.id),
        membershipProvenance: provenance,
        updatedAt: nowIso()
      };
      await this.persist();
    } catch (error) {
      const errorCode = "membership_mirror_failed";
      this.state.rooms[roomId] = {
        roomId,
        title: configured(room?.title) || existingState?.title,
        covered: false,
        membershipId: existingState?.membershipId,
        membershipProvenance: existingState?.membershipProvenance,
        lastError: errorCode,
        updatedAt: nowIso()
      };
      await this.persist();
      await this.notifyOnce(`coverage:${roomId}:${errorCode}`, roomId, `Could not add the configured meeting attendee to this space (${errorCode}). A moderator must allow or add ${this.cfg.expectedAttendeeEmail}.`).catch((notificationError) => this.logFailure(`coverage notification ${roomId}`, notificationError));
      this.logFailure(`membership mirror ${roomId}`, error);
    }
  }
  async removeManagedRoom(roomId) {
    const room = this.state.rooms[roomId];
    for (const schedule of Object.values(this.state.schedules)) if (schedule.roomId === roomId) this.deleteSchedule(schedule.id);
    for (const pending of Object.values(this.state.pending)) if (pending.roomId === roomId) delete this.state.pending[pending.meetingId];
    for (const dismissal of Object.values(this.dismissals())) if (dismissal.roomId === roomId) delete this.dismissals()[dismissal.meetingId];
    const active = Object.values(this.state.sessions).find((session) => session.roomId === roomId && ACTIVE_STATES.has(session.state));
    if (active) await this.leave(roomId);
    if (room?.membershipProvenance === "created" && room.membershipId) {
      const token = await this.getAccessToken().catch(() => "");
      if (token) await webexRequest(token, `/memberships/${encodeURIComponent(room.membershipId)}`, { method: "DELETE" }).catch((error) => this.logFailure(`attendee self-removal ${roomId}`, error));
    }
    delete this.state.rooms[roomId];
    await this.persist();
  }
  async reconcileMeetings() {
    if (!this.enabled) return;
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - 24 * 60 * 6e4).toISOString();
    const to = new Date(Date.now() + this.cfg.schedulingHorizonDays * 24 * 60 * 6e4).toISOString();
    const series = await webexList(token, `/meetings?meetingType=meetingSeries&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
    for (const meeting of series) await this.processMeeting(meeting);
    const scheduled = await webexList(token, `/meetings?meetingType=scheduledMeeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
    for (const meeting of scheduled) await this.processMeeting(meeting);
    const active = await this.listMeetingInstances(token, from, to);
    for (const meeting of active) await this.processMeeting(meeting);
    await this.drainPending();
    this.pruneSchedules();
    await this.persist();
  }
  listMeetingInstances(token, from, to) {
    return webexList(token, `/meetings?meetingType=meeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
  }
  async fetchMeetingWithRetry(meetingId) {
    const started = Date.now();
    const initialDelays = [0, 1e3, 2e3, 5e3, 1e4, 2e4, 3e4];
    let attempt = 0;
    while (!this.stopped && Date.now() - started <= 10 * 6e4) {
      const wait = initialDelays[attempt] ?? 3e4;
      if (wait) await delay(wait);
      try {
        return (await webexRequest(await this.getAccessToken(), `/meetings/${encodeURIComponent(meetingId)}`)).data;
      } catch (error) {
        if (!(error instanceof WebexApiError) || ![404, 409, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      }
      attempt += 1;
    }
    return null;
  }
  resolveMeetingRoomId(meeting) {
    const direct = configured(meeting?.roomId);
    if (direct) return direct;
    const scheduledId = configured(meeting?.scheduledMeetingId);
    if (scheduledId && this.state.schedules[scheduledId]) return this.state.schedules[scheduledId].roomId;
    const seriesId = configured(meeting?.meetingSeriesId);
    if (seriesId) return Object.values(this.state.schedules).find((item) => item.seriesId === seriesId)?.roomId ?? "";
    return "";
  }
  async processMeeting(meeting) {
    const meetingType = configured(meeting?.meetingType);
    const state = configured(meeting?.state);
    const meetingId = configured(meeting?.id);
    if (!meetingId) return;
    if (meetingType === "meetingSeries") {
      const seriesRoomId = this.resolveMeetingRoomId(meeting);
      const token = await this.getAccessToken();
      const from = (/* @__PURE__ */ new Date()).toISOString();
      const to = new Date(Date.now() + this.cfg.schedulingHorizonDays * 24 * 60 * 6e4).toISOString();
      const occurrences = await webexList(token, `/meetings?meetingSeriesId=${encodeURIComponent(meetingId)}&meetingType=scheduledMeeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
      for (const occurrence of occurrences) {
        await this.processMeeting(seriesRoomId && !configured(occurrence?.roomId) ? { ...occurrence, roomId: seriesRoomId } : occurrence);
      }
      return;
    }
    const roomId = this.resolveMeetingRoomId(meeting);
    if (!roomId || !this.state.rooms[roomId]?.covered) return;
    if (meetingType === "scheduledMeeting") {
      if (["ended", "missed"].includes(state)) this.deleteSchedule(meetingId);
      else this.upsertSchedule(meeting, roomId);
      await this.persist();
      return;
    }
    if (isJoinableMeeting(meeting)) await this.joinDiscoveredMeeting(meeting, roomId);
    else if (isTerminalMeeting(meeting)) await this.endMeeting(meetingId, roomId);
  }
  upsertSchedule(meeting, roomId) {
    const start = configured(meeting?.start);
    const meetingId = configured(meeting?.id);
    if (!start || !meetingId || !Number.isFinite(Date.parse(start))) return;
    const webLink = configured(meeting?.webLink);
    const sipAddress = configured(meeting?.sipAddress);
    const destination = webLink || sipAddress || configured(meeting?.meetingNumber) || meetingId;
    this.state.schedules[meetingId] = {
      id: meetingId,
      seriesId: configured(meeting?.meetingSeriesId) || void 0,
      roomId,
      title: configured(meeting?.title) || void 0,
      start,
      end: configured(meeting?.end) || void 0,
      destination,
      webLink: webLink || void 0,
      sipAddress: sipAddress || void 0,
      password: configured(meeting?.password) || void 0,
      fallbackUntil: new Date(Date.parse(start) + this.cfg.scheduledStartGraceMinutes * 6e4).toISOString(),
      updatedAt: nowIso()
    };
    this.armSchedule(meetingId);
  }
  rebuildScheduleTimers() {
    for (const meetingId of Object.keys(this.state.schedules)) this.armSchedule(meetingId);
  }
  armSchedule(meetingId, retryMs) {
    const schedule = this.state.schedules[meetingId];
    if (!schedule) return;
    const previous = this.scheduleTimers.get(meetingId);
    if (previous) clearTimeout(previous);
    const delayMs = retryMs ?? Math.max(0, Date.parse(schedule.start) - Date.now());
    if (Date.now() > Date.parse(schedule.fallbackUntil)) return;
    const maxTimeoutMs = 2147e6;
    const callback = delayMs > maxTimeoutMs ? () => this.armSchedule(meetingId) : () => this.pollScheduledMeeting(meetingId).catch((error) => this.logFailure(`scheduled poll ${meetingId}`, error));
    const timer = setTimeout(callback, Math.min(delayMs, maxTimeoutMs));
    timer.unref?.();
    this.scheduleTimers.set(meetingId, timer);
  }
  async pollScheduledMeeting(meetingId) {
    this.scheduleTimers.delete(meetingId);
    const schedule = this.state.schedules[meetingId];
    if (!schedule || Date.now() > Date.parse(schedule.fallbackUntil)) return;
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - 24 * 60 * 6e4).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 6e4).toISOString();
    const active = await this.listMeetingInstances(token, from, to);
    for (const meeting of active) await this.processMeeting(meeting);
    const joined = Object.values(this.state.sessions).some((session) => session.invitation.meetingId && session.roomId === schedule.roomId && ACTIVE_STATES.has(session.state));
    if (!joined) this.armSchedule(meetingId, 15e3);
  }
  deleteSchedule(meetingId) {
    const timer = this.scheduleTimers.get(meetingId);
    if (timer) clearTimeout(timer);
    this.scheduleTimers.delete(meetingId);
    delete this.state.schedules[meetingId];
  }
  pruneSchedules() {
    const cutoff = Date.now() - 60 * 6e4;
    for (const schedule of Object.values(this.state.schedules)) {
      const expiry = Date.parse(schedule.end ?? schedule.fallbackUntil);
      if (expiry < cutoff) this.deleteSchedule(schedule.id);
    }
    for (const pending of Object.values(this.state.pending)) if (Date.parse(pending.expiresAt) < Date.now()) delete this.state.pending[pending.meetingId];
    for (const dismissal of Object.values(this.dismissals())) if (Date.parse(dismissal.expiresAt) < Date.now()) delete this.dismissals()[dismissal.meetingId];
  }
  // State persisted before this field existed decrypts without it; initialize on
  // demand so every access is safe regardless of the stored schema version.
  dismissals() {
    return this.state.dismissed ??= {};
  }
  /**
   * True while the user's explicit leave of this meeting still holds. Matches
   * by id root, and by room + link/destination for id forms the session never
   * learned (manual link joins, webhook/list id divergence).
   */
  isDismissedInvitation(invitation, roomId) {
    for (const dismissal of Object.values(this.dismissals())) {
      if (Date.parse(dismissal.expiresAt) < Date.now()) {
        delete this.dismissals()[dismissal.meetingId];
        continue;
      }
      if (sameMeetingId(dismissal.meetingId, invitation.meetingId)) return true;
      if (dismissal.roomId !== roomId) continue;
      if (dismissal.webLink && invitation.joinLink && dismissal.webLink === invitation.joinLink) return true;
      if (dismissal.destination && dismissal.destination === invitation.destination) return true;
    }
    return false;
  }
  async joinDiscoveredMeeting(meeting, roomId = this.resolveMeetingRoomId(meeting)) {
    if (!this.enabled) await this.start();
    if (!roomId || !this.state.rooms[roomId]?.covered) return { accepted: false, state: "failed", error_code: "space_not_covered" };
    const invitation = createDiscoveredInvitation(meeting, roomId);
    if (!invitation) return { accepted: false, state: "failed", error_code: "meeting_destination_invalid" };
    if (this.isDismissedInvitation(invitation, roomId)) {
      return { accepted: false, state: "left", error_code: "meeting_left_by_user" };
    }
    const sameMeeting = (session) => Boolean(
      sameMeetingId(invitation.meetingId, session.invitation.meetingId) || invitation.joinLink && session.invitation.joinLink === invitation.joinLink || session.invitation.destination === invitation.destination
    );
    const existing = Object.values(this.state.sessions).find(
      (session) => ACTIVE_STATES.has(session.state) && (sameMeeting(session) || session.roomId === roomId)
    );
    if (existing && sameMeeting(existing)) {
      if (invitation.meetingId && !existing.invitation.meetingId) {
        existing.invitation.meetingId = invitation.meetingId;
        if (invitation.meetingNumber && !existing.invitation.meetingNumber) existing.invitation.meetingNumber = invitation.meetingNumber;
        await this.persist();
      }
      return this.browserReadyResult(existing);
    }
    const activeCount = Object.values(this.state.sessions).filter((session) => ACTIVE_STATES.has(session.state)).length;
    if (existing || activeCount >= this.cfg.maxConcurrentMeetings) {
      this.state.pending[invitation.meetingId] = {
        meetingId: invitation.meetingId,
        roomId,
        destination: invitation.destination,
        webLink: invitation.joinLink,
        password: invitation.password,
        meetingNumber: invitation.meetingNumber,
        expiresAt: configured(meeting?.end) || new Date(Date.now() + 4 * 60 * 6e4).toISOString(),
        updatedAt: nowIso()
      };
      await this.persist();
      return { accepted: false, state: "pending", error_code: existing ? "active_meeting_requires_leave" : "capacity_reached" };
    }
    delete this.state.pending[invitation.meetingId];
    return this.joinTarget(roomId, void 0, invitation, "automatic");
  }
  async drainPending() {
    for (const pending of Object.values(this.state.pending).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (Date.parse(pending.expiresAt) < Date.now()) {
        delete this.state.pending[pending.meetingId];
        continue;
      }
      const result = await this.joinDiscoveredMeeting({
        id: pending.meetingId,
        roomId: pending.roomId,
        webLink: pending.webLink,
        password: pending.password,
        meetingNumber: pending.meetingNumber,
        end: pending.expiresAt
      }, pending.roomId);
      if (result.accepted) delete this.state.pending[pending.meetingId];
    }
  }
  async join(input) {
    await this.start();
    const roomId = configured(input?.room_id);
    const parentId = configured(input?.parent_id) || void 0;
    const invitation = createInvitation(input?.meeting_link, input?.meeting_password);
    if (!roomId || !invitation) return { accepted: false, state: "failed", error_code: "meeting_credentials_invalid" };
    return this.joinTarget(roomId, parentId, invitation, "manual");
  }
  async joinTarget(roomId, parentId, invitation, source) {
    if (!this.enabled) return { accepted: false, state: "failed", error_code: "meeting_join_unavailable" };
    if (source === "manual") {
      for (const dismissal of Object.values(this.dismissals())) if (dismissal.roomId === roomId) delete this.dismissals()[dismissal.meetingId];
    }
    const existing = Object.values(this.state.sessions).find((session2) => session2.roomId === roomId && ACTIVE_STATES.has(session2.state));
    if (existing) {
      if (existing.invitation.destination === invitation.destination || existing.invitation.meetingId === invitation.meetingId) return this.browserReadyResult(existing);
      return { accepted: false, state: existing.state, error_code: "active_meeting_requires_leave" };
    }
    if (Object.values(this.state.sessions).filter((session2) => ACTIVE_STATES.has(session2.state)).length >= this.cfg.maxConcurrentMeetings) {
      return { accepted: false, state: "failed", error_code: "capacity_reached" };
    }
    const session = {
      id: randomUUID(),
      roomId,
      parentId,
      source,
      invitation,
      state: "preparing",
      recoveryAttempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const kind = invitation.destinationKind ?? "web_link";
    if (kind === "web_link") {
      this.log?.info?.(`[webex-auto-join] session ${session.id} joining ${roomId} via web_link`);
    } else {
      this.log?.warn?.(`[webex-auto-join] session ${session.id} joining ${roomId} via ${kind} (web_link unavailable; fallback destination)`);
    }
    this.state.sessions[session.id] = session;
    await this.persist();
    try {
      if (!this.cfg.requireBrowserReview) await this.transition(session, "joining");
      await this.launch(session);
      if (this.cfg.requireBrowserReview) await this.transition(session, "ready_for_browser");
      return this.browserReadyResult(session);
    } catch (error) {
      const code = safeErrorCode(error);
      const detail = safeErrorDetail(error, "runner_launch");
      await this.fail(session, code, detail);
      return { accepted: false, session_id: session.id, state: "failed", error_code: code, error_detail: detail };
    }
  }
  browserReadyResult(session) {
    const needsBrowserAction = this.cfg.requireBrowserReview && session.state === "ready_for_browser";
    return {
      accepted: true,
      session_id: session.id,
      state: session.state,
      ...needsBrowserAction ? {
        browser_profile: this.cfg.browserProfile,
        tab_id: session.tabId,
        tab_label: session.tabLabel,
        next_action: "Call inspect_webex_meeting_runner with this session_id, choose the visible join action from its fresh snapshot, then call act_webex_meeting_runner with that ref."
      } : {}
    };
  }
  async leave(roomId) {
    const active = Object.values(this.state.sessions).filter((item) => ACTIVE_STATES.has(item.state));
    let session = active.find((item) => item.roomId === roomId);
    if (!session && active.length === 1) {
      session = active[0];
      this.log?.info?.(`[webex-auto-join] leave: room ${roomId || "(none)"} had no session; leaving the sole active meeting in ${session.roomId}`);
    }
    if (!session) {
      if (active.length > 1) {
        return {
          accepted: false,
          state: "active",
          error_code: "ambiguous_active_meeting",
          active_meetings: active.map((item) => ({
            session_id: item.id,
            room_id: item.roomId,
            room_title: this.state.rooms[item.roomId]?.title,
            meeting_id: item.invitation.meetingId
          }))
        };
      }
      return { accepted: false, state: "left", error_code: "no_active_meeting" };
    }
    session.leaveRequested = true;
    const dismissedAt = nowIso();
    const expiresAt = new Date(Date.now() + DISMISSAL_TTL_MS).toISOString();
    const meetingId = configured(session.invitation.meetingId);
    const dismissalKey = meetingId || `link:${session.invitation.destination}`;
    this.dismissals()[dismissalKey] = {
      meetingId: dismissalKey,
      roomId: session.roomId,
      webLink: session.invitation.joinLink,
      destination: session.invitation.destination,
      dismissedAt,
      expiresAt
    };
    if (meetingId) delete this.state.pending[meetingId];
    for (const pending of Object.values(this.state.pending)) {
      if (pending.roomId !== session.roomId) continue;
      const sameLink = session.invitation.joinLink && pending.webLink === session.invitation.joinLink;
      if (sameMeetingId(pending.meetingId, meetingId) || sameLink || pending.destination === session.invitation.destination) {
        this.dismissals()[pending.meetingId] = {
          meetingId: pending.meetingId,
          roomId: session.roomId,
          webLink: pending.webLink,
          destination: pending.destination,
          dismissedAt,
          expiresAt
        };
        delete this.state.pending[pending.meetingId];
      }
    }
    await this.transition(session, "leaving");
    const timer = setTimeout(() => {
      if (session.state === "leaving") this.completeLeave(session).catch(() => void 0);
    }, 15e3);
    timer.unref?.();
    return { accepted: true, state: "leaving" };
  }
  status(roomId) {
    const rooms = Object.values(this.state.rooms).filter((room) => !roomId || room.roomId === roomId).map((room) => ({
      room_id: room.roomId,
      title: room.title,
      covered: room.covered,
      error_code: room.lastError
    }));
    const upcoming = Object.values(this.state.schedules).filter((item) => !roomId || item.roomId === roomId).map((item) => ({
      meeting_id: item.id,
      room_id: item.roomId,
      title: item.title,
      start: item.start,
      end: item.end
    }));
    const active = Object.values(this.state.sessions).filter((item) => ACTIVE_STATES.has(item.state) && (!roomId || item.roomId === roomId)).map((item) => ({
      session_id: item.id,
      meeting_id: item.invitation.meetingId,
      room_id: item.roomId,
      state: item.state,
      source: item.source
    }));
    const failures = Object.values(this.state.sessions).filter((item) => item.state === "failed" && (!roomId || item.roomId === roomId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map((item) => ({
      session_id: item.id,
      meeting_id: item.invitation.meetingId,
      room_id: item.roomId,
      error_code: safePublicFailureCode(item.errorCode),
      error_detail: safePublicFailureDetail(item.errorDetail),
      updated_at: item.updatedAt
    }));
    return {
      enabled: this.enabled,
      startup_error_code: this.startupErrorCode,
      rooms,
      upcoming,
      active,
      failures,
      pending: Object.keys(this.state.pending).length
    };
  }
  async inspectRunner(sessionId) {
    await this.start();
    const session = this.state.sessions[configured(sessionId)];
    if (!session) return { ok: false, error_code: "meeting_session_not_found", retryable: false };
    if (!ACTIVE_STATES.has(session.state) || !session.tabId) return { ok: false, state: session.state, error_code: "meeting_runner_not_ready", retryable: false };
    try {
      const snapshot = await this.browser.snapshot(session.tabId);
      const targetId = configured(snapshot?.targetId);
      if (!targetId) throw new BrowserControlError("Meeting runner snapshot did not return a targetId", "browser_control_unavailable");
      session.inspectedTargetId = targetId;
      session.inspectedRefs = snapshotRefs(snapshot);
      return { ok: true, session_id: session.id, state: session.state, snapshot: snapshot.snapshot ?? snapshot.nodes ?? "", refs: snapshot.refs ?? {}, target_binding: "internal", truncated: Boolean(snapshot.truncated) };
    } catch (error) {
      session.inspectedTargetId = void 0;
      session.inspectedRefs = void 0;
      this.logFailure("runner inspection", error);
      return { ok: false, state: session.state, error_code: "meeting_runner_inspection_failed", retryable: true };
    }
  }
  async actOnRunner(sessionId, ref) {
    await this.start();
    const session = this.state.sessions[configured(sessionId)];
    if (!session) return { ok: false, error_code: "meeting_session_not_found", retryable: false };
    if (session.state !== "ready_for_browser" || !session.tabId) return { ok: false, state: session.state, error_code: "meeting_runner_not_ready", retryable: false };
    const normalizedRef = configured(ref);
    if (!/^(?:\d+|e\d+|ax\d+)$/.test(normalizedRef)) return { ok: false, state: session.state, error_code: "meeting_runner_ref_invalid", retryable: true };
    if (!session.inspectedTargetId || !session.inspectedRefs?.includes(normalizedRef)) return { ok: false, state: session.state, error_code: "meeting_runner_snapshot_required", retryable: true };
    const targetId = session.inspectedTargetId;
    session.inspectedTargetId = void 0;
    session.inspectedRefs = void 0;
    try {
      await this.browser.click(targetId, normalizedRef);
      return { ok: true, session_id: session.id, state: session.state, action: "click_submitted", next_action: "Inspect the meeting runner again to verify its visible status." };
    } catch (error) {
      return { ok: false, state: session.state, ...browserActionFailure(error) };
    }
  }
  async handleRunnerRoute(req, res) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.statusCode = 403;
      res.end("Loopback only");
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/webex-auto-join\/runner\/([^/]+)(?:\/(bootstrap|events|control))?$/);
    if (!match) return false;
    const [, sessionId, action] = match;
    const session = this.state.sessions[sessionId];
    if (!session) return sendJson(res, 404, { error: "not_found" }), true;
    const cookie = parseCookies(req.headers?.cookie).webex_auto_join_session;
    const cookieSession = cookie ? this.runnerCookies.get(cookie) : null;
    const authenticated = Boolean(cookieSession && cookieSession.sessionId === sessionId && cookieSession.expiresAt > Date.now());
    if (!action) {
      if (authenticated) {
        if (url.searchParams.has("sdk")) return this.serveAsset(res, this.assets.sdk ?? process.env.MEETING_JOIN_WEBEX_SDK_PATH, "application/javascript; charset=utf-8", "webex_sdk_asset_unavailable");
        if (url.searchParams.has("asset")) return this.serveAsset(res, this.assets.runner ?? process.env.MEETING_JOIN_RUNNER_PATH, "application/javascript; charset=utf-8", "runner_asset_unavailable");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw Webex Auto Join</title></head><body data-autostart="${this.cfg.requireBrowserReview ? "false" : "true"}"><main><h1>Webex meeting</h1><p id="meeting-status" role="status" aria-live="polite">Ready to join with the configured Webex user.</p><button id="join-meeting" type="button">Join Webex meeting</button></main><script src="${url.pathname}?sdk=1"></script><script src="${url.pathname}?asset=1"></script></body></html>`);
        return true;
      }
      const nonce = url.searchParams.get("nonce");
      const nonceSession = nonce ? this.runnerNonces.get(nonce) : null;
      if (!nonceSession || nonceSession.sessionId !== sessionId || nonceSession.expiresAt < Date.now()) return sendJson(res, 403, { error: "unauthorized" }), true;
      this.runnerNonces.delete(nonce);
      const sessionCookie = randomBytes2(24).toString("base64url");
      this.runnerCookies.set(sessionCookie, { sessionId, expiresAt: Date.now() + 60 * 6e4 });
      res.statusCode = 302;
      res.setHeader("Set-Cookie", `webex_auto_join_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/webex-auto-join/runner/${sessionId}`);
      res.setHeader("Location", `/webex-auto-join/runner/${sessionId}`);
      res.end();
      return true;
    }
    if (!authenticated) return sendJson(res, 403, { error: "unauthorized" }), true;
    if (action === "bootstrap" && req.method === "GET") {
      try {
        return sendJson(res, 200, { accessToken: await this.getAccessToken(), destination: session.invitation.destination, joinLink: session.invitation.joinLink, password: session.invitation.password, meetingId: session.invitation.meetingId, sessionId, audioTap: this.audio.register(sessionId) }), true;
      } catch (error) {
        return sendJson(res, 503, { error: safeErrorCode(error) }), true;
      }
    }
    if (action === "control" && req.method === "GET") return sendJson(res, 200, { leave: Boolean(session.leaveRequested) }), true;
    if (action === "events" && req.method === "POST") {
      try {
        await this.handleRunnerEvent(session, await readJsonBody(req));
        return sendJson(res, 200, { ok: true }), true;
      } catch {
        return sendJson(res, 400, { error: "invalid_event" }), true;
      }
    }
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }
  async serveAsset(res, filename, contentType, errorCode) {
    try {
      if (!filename) throw new Error("asset path missing");
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.end(await readFile(filename));
    } catch {
      sendJson(res, 500, { error: errorCode });
    }
    return true;
  }
  async handleRunnerEvent(session, event) {
    const type = configured(event?.type);
    if (type === "joining") await this.transition(session, "joining");
    else if (type === "waiting_for_admission") await this.transition(session, "waiting_for_admission");
    else if (type === "joined") {
      session.recoveryAttempts = 0;
      await this.transition(session, "joined");
    } else if (type === "left") await this.completeLeave(session);
    else if (type === "ended") await this.completeEnd(session);
    else if (type === "error") {
      if (session.leaveRequested) return this.completeLeave(session);
      const code = configured(event?.code) || "meeting_join_failed";
      const detail = safePublicFailureDetail(event?.detail);
      if (session.recoveryAttempts > 0 && session.recoveryAttempts < this.cfg.recoveryMaxAttempts) {
        await this.transition(session, "interrupted");
        this.recover(session).catch(() => this.fail(session, code, detail));
      } else await this.fail(session, code, detail);
    } else if (type === "audio_tap") {
      const code = configured(event?.code) || "unknown";
      const detail = safePublicFailureDetail(event?.detail);
      this.log?.info?.(`[webex-auto-join] audio tap ${code} session=${session.id}${detail ? ` ${detail}` : ""}`);
    } else if (type === "heartbeat") {
      session.updatedAt = nowIso();
      await this.persist();
    }
  }
  async launch(session) {
    await this.getAccessToken();
    await this.browser.start();
    const nonce = randomBytes2(24).toString("base64url");
    this.runnerNonces.set(nonce, { sessionId: session.id, expiresAt: Date.now() + 6e4 });
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789);
    const runnerUrl = `http://127.0.0.1:${port}/webex-auto-join/runner/${session.id}?nonce=${encodeURIComponent(nonce)}`;
    session.tabLabel = `meeting:${Buffer.from(session.roomId).toString("base64url").slice(0, 20)}`;
    session.inspectedTargetId = void 0;
    session.inspectedRefs = void 0;
    session.tabId = await this.browser.open(runnerUrl, session.tabLabel);
    if (!session.tabId) throw new Error("Browser did not return a meeting tab identifier");
    session.updatedAt = nowIso();
    await this.persist();
  }
  async recoverActiveSessions() {
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state) || session.state === "leaving") continue;
      this.recover(session).catch((error) => this.logFailure("session recovery", error));
    }
  }
  async checkHeartbeats() {
    const cutoff = Date.now() - 45e3;
    for (const session of Object.values(this.state.sessions)) {
      if (!["joining", "waiting_for_admission", "joined"].includes(session.state) || Date.parse(session.updatedAt) >= cutoff) continue;
      await this.transition(session, "interrupted");
      this.recover(session).catch(() => this.fail(session, "runner_heartbeat_lost", "stage=runner_heartbeat; message=Meeting runner stopped reporting heartbeats"));
    }
  }
  async recover(session) {
    let lastErrorDetail = "";
    while (session.recoveryAttempts < this.cfg.recoveryMaxAttempts && ACTIVE_STATES.has(session.state)) {
      if (session.leaveRequested || session.state === "leaving") return this.completeLeave(session);
      session.recoveryAttempts += 1;
      await this.transition(session, "recovering");
      try {
        await this.browser.close(session.tabId);
        if (!this.cfg.requireBrowserReview) await this.transition(session, "joining");
        await this.launch(session);
        if (this.cfg.requireBrowserReview) await this.transition(session, "ready_for_browser");
        return;
      } catch (error) {
        lastErrorDetail = safeErrorDetail(error, "runner_recovery");
        await delay(this.cfg.recoveryBaseDelayMs * 2 ** (session.recoveryAttempts - 1) + Math.floor(Math.random() * 250));
      }
    }
    if (session.leaveRequested || session.state === "leaving") return this.completeLeave(session);
    await this.fail(session, "recovery_exhausted", lastErrorDetail || "stage=runner_recovery; message=Recovery attempts were exhausted");
  }
  async endMeeting(meetingId, roomId) {
    delete this.state.pending[meetingId];
    for (const dismissal of Object.values(this.dismissals())) {
      if (sameMeetingId(dismissal.meetingId, meetingId) || roomId && dismissal.roomId === roomId) delete this.dismissals()[dismissal.meetingId];
    }
    this.deleteSchedule(configured(Object.values(this.state.schedules).find((schedule) => schedule.roomId === roomId && (schedule.id === meetingId || schedule.seriesId === meetingId))?.id));
    const session = Object.values(this.state.sessions).find((item) => item.invitation.meetingId === meetingId || item.roomId === roomId);
    if (session && ACTIVE_STATES.has(session.state)) await this.completeEnd(session);
    await this.persist();
  }
  async removeMeeting(meetingId, roomId) {
    if (meetingId) this.deleteSchedule(meetingId);
    if (meetingId) delete this.state.pending[meetingId];
    if (meetingId) delete this.dismissals()[meetingId];
    const session = Object.values(this.state.sessions).find((item) => item.invitation.meetingId === meetingId);
    if (roomId || session) await this.endMeeting(meetingId, roomId || session?.roomId || "");
    await this.persist();
  }
  async completeLeave(session) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = void 0;
    await this.transition(session, "left");
    await this.drainPending();
  }
  async completeEnd(session) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = void 0;
    await this.transition(session, "ended");
    await this.drainPending();
  }
  async fail(session, code, detail) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = void 0;
    await this.transition(session, "failed", safePublicFailureCode(code), safePublicFailureDetail(detail));
    await this.drainPending();
  }
  async transition(session, next, errorCode, errorDetail) {
    session.state = next;
    session.updatedAt = nowIso();
    if (next === "failed") {
      session.errorCode = safePublicFailureCode(errorCode);
      session.errorDetail = safePublicFailureDetail(errorDetail) || void 0;
    } else if (!["interrupted", "recovering"].includes(next)) {
      session.errorCode = void 0;
      session.errorDetail = void 0;
    }
    if (["left", "ended", "failed"].includes(next)) session.leaveRequested = false;
    await this.persist();
    if (next === "joined" && this.cfg.notificationMode === "join-and-failure") {
      const message = session.source === "automatic" ? "Joined the Webex meeting automatically." : "Joined the Webex meeting.";
      await this.notifyOnce(`joined:${session.invitation.meetingId ? meetingIdRoot(session.invitation.meetingId) : session.id}`, session.roomId, message).catch((error) => this.logFailure("joined notification", error));
    } else if (next === "failed") {
      const code = session.errorCode ?? "meeting_join_failed";
      const detail = session.errorDetail || "No additional diagnostic was supplied by the Webex SDK.";
      this.log?.warn?.(`[webex-auto-join] session ${session.id} failed: ${code}; ${detail}`);
      const notification = [
        "Could not join or continue the Webex meeting.",
        `Error code: ${code}`,
        `Diagnostic: ${detail}`,
        `Session: ${session.id}`
      ].join("\n\n");
      await this.notifyOnce(`failed-v2:${session.invitation.meetingId ?? session.id}`, session.roomId, notification).catch((error) => this.logFailure("failure notification", error));
    }
  }
  async notifyOnce(key, roomId, markdown) {
    if (this.state.notifications[key]) return;
    await this.messages.send(roomId, markdown);
    this.state.notifications[key] = nowIso();
    await this.persist();
  }
  invalidateRunnerAuth(sessionId) {
    for (const [nonce, value2] of this.runnerNonces) if (value2.sessionId === sessionId) this.runnerNonces.delete(nonce);
    for (const [cookie, value2] of this.runnerCookies) if (value2.sessionId === sessionId) this.runnerCookies.delete(cookie);
    this.audio.unregister(sessionId);
  }
  async getAccessToken() {
    if (!this.store) throw new Error("auto-join state unavailable");
    const cached = this.state.token;
    if (cached && cached.expiresAt > Date.now() + 12e4) return cached.accessToken;
    const refreshToken = cached?.refreshToken ?? this.cfg.attendeeRefreshToken;
    if (!refreshToken || !this.cfg.attendeeClientId || !this.cfg.attendeeClientSecret) throw new Error("meeting OAuth credentials are unavailable");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.cfg.attendeeClientId, client_secret: this.cfg.attendeeClientSecret });
    const response = await fetch(`${WEBEX_API}/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`);
    const token = await response.json();
    if (!token.access_token) throw new Error("OAuth refresh response incomplete");
    this.state.token = { accessToken: token.access_token, refreshToken: token.refresh_token ?? refreshToken, expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1e3 };
    await this.persist();
    return token.access_token;
  }
  async persist() {
    if (this.store) await this.store.save(this.state);
  }
  logFailure(context, error) {
    const detail = safeErrorDetail(error, context);
    this.log?.warn?.(`[webex-auto-join] ${context}: ${safeErrorCode(error)}; ${detail}`);
  }
};

// src/index.ts
import { fileURLToPath } from "node:url";

// openclaw.plugin.json
var openclaw_plugin_default = {
  id: "webex-auto-join",
  name: "Webex Auto Join",
  description: "Mirrors a licensed attendee into bot spaces and automatically joins their scheduled and instant Webex meetings.",
  activation: { onStartup: true },
  skills: ["skills"],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      botToken: { type: "string", description: "Webex messaging bot access token." },
      webhookUrl: { type: "string", description: "Public HTTPS URL ending in /webhooks/webex-auto-join." },
      webhookSecret: { type: "string", description: "Secret used for Webex webhook HMAC-SHA1 signatures." },
      attendeeClientId: { type: "string", description: "OAuth integration client ID for the licensed attendee." },
      attendeeClientSecret: { type: "string", description: "OAuth integration client secret for the licensed attendee." },
      attendeeRefreshToken: { type: "string", description: "Initial OAuth refresh token for the licensed attendee." },
      expectedAttendeeEmail: { type: "string", description: "Expected email address of the licensed attendee identity." },
      encryptionKey: { type: "string", description: "Base64-encoded 32-byte AES state-encryption key." },
      maxConcurrentMeetings: { type: "integer", minimum: 1, default: 4 },
      browserProfile: { type: "string", default: "webex-auto-join" },
      audioTap: { type: "boolean", default: true, description: "Receive meeting audio and stream it to the local audio bridge. Disable to join without media." },
      requireBrowserReview: { type: "boolean", default: false },
      meetingReconcileIntervalSeconds: { type: "integer", minimum: 15, default: 60 },
      membershipReconcileIntervalSeconds: { type: "integer", minimum: 60, default: 300 },
      schedulingHorizonDays: { type: "integer", minimum: 1, default: 30 },
      scheduledStartGraceMinutes: { type: "integer", minimum: 1, default: 30 },
      notificationMode: { type: "string", enum: ["join-and-failure", "failures-only"], default: "join-and-failure" },
      recoveryMaxAttempts: { type: "integer", minimum: 1, default: 5 },
      recoveryBaseDelayMs: { type: "integer", minimum: 100, default: 1e3 }
    }
  },
  uiHints: {
    botToken: { sensitive: true },
    webhookSecret: { sensitive: true },
    attendeeClientSecret: { sensitive: true },
    attendeeRefreshToken: { sensitive: true },
    encryptionKey: { sensitive: true }
  },
  version: "1.0.0",
  contracts: {
    tools: [
      "join_webex_meeting",
      "leave_webex_meeting",
      "inspect_webex_meeting_runner",
      "act_webex_meeting_runner",
      "webex_auto_join_status"
    ]
  },
  toolMetadata: {
    join_webex_meeting: { optional: true },
    leave_webex_meeting: { optional: true },
    inspect_webex_meeting_runner: { optional: true },
    act_webex_meeting_runner: { optional: true },
    webex_auto_join_status: { optional: true }
  }
};

// src/index.ts
var SERVICE_KEY = Symbol.for("openclaw.webex-auto-join.service");
function assetPaths() {
  return {
    runner: fileURLToPath(new URL("./runner.js", import.meta.url)),
    sdk: fileURLToPath(new URL("./webex.min.js", import.meta.url))
  };
}
function validationEntry() {
  const entry = {};
  Object.defineProperty(entry, Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata"), {
    value: {
      id: openclaw_plugin_default.id,
      name: openclaw_plugin_default.name,
      description: openclaw_plugin_default.description,
      activation: openclaw_plugin_default.activation,
      configSchema: openclaw_plugin_default.configSchema,
      tools: openclaw_plugin_default.contracts.tools.map((name) => ({ name, optional: true }))
    }
  });
  return entry;
}
function toToolResult(value2) {
  return { content: [{ type: "text", text: JSON.stringify(value2) }], details: value2 };
}
function getSharedService(api) {
  const root = globalThis;
  if (!root[SERVICE_KEY]) {
    const pluginConfig = api.pluginConfig ?? api.config?.plugins?.entries?.["webex-auto-join"]?.config ?? api.config ?? {};
    root[SERVICE_KEY] = new MeetingJoinService(api.runtime, pluginConfig, api.logger ?? console, assetPaths());
  }
  return root[SERVICE_KEY];
}
function registerTools(api, resolveService) {
  api.registerTool({
    name: "join_webex_meeting",
    description: "Join a Webex meeting using the meeting credentials supplied in the Webex request.",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Current Webex RoomId." },
        parent_id: { type: "string", description: "Current MessageThreadId when present." },
        meeting_link: { type: "string", description: "HTTPS Webex meeting link from the invitation." },
        meeting_password: { type: "string", description: "Ordinary Meeting password from the invitation; do not use the video-system password." }
      },
      required: ["room_id", "meeting_link", "meeting_password"]
    },
    execute: async (_id, args) => toToolResult(await resolveService().join(args))
  }, { optional: true });
  api.registerTool({
    name: "leave_webex_meeting",
    description: "Leave an active Webex meeting. Pass the current room ID; if that space has no active session, the sole active meeting is left instead, so call this whenever any meeting is active \u2014 no meeting link is needed. If several meetings are active it returns ambiguous_active_meeting with the candidates.",
    parameters: {
      type: "object",
      properties: { room_id: { type: "string", description: "The current Webex room ID from the inbound context." } },
      required: ["room_id"]
    },
    execute: async (_id, args) => toToolResult(await resolveService().leave(String(args?.room_id ?? "")))
  }, { optional: true });
  api.registerTool({
    name: "inspect_webex_meeting_runner",
    description: "Inspect the secure meeting runner for one accepted join session and return a semantic snapshot with fresh action refs.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID returned by join_webex_meeting." }
      },
      required: ["session_id"]
    },
    execute: async (_id, args) => toToolResult(
      await resolveService().inspectRunner(String(args?.session_id ?? ""))
    )
  }, { optional: true });
  api.registerTool({
    name: "act_webex_meeting_runner",
    description: "Click one fresh semantic ref in the secure meeting runner. The plugin resolves the session tab internally; do not supply a targetId.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID returned by join_webex_meeting." },
        ref: { type: "string", description: "Fresh clickable ref selected from inspect_webex_meeting_runner output." }
      },
      required: ["session_id", "ref"]
    },
    execute: async (_id, args) => toToolResult(
      await resolveService().actOnRunner(String(args?.session_id ?? ""), String(args?.ref ?? ""))
    )
  }, { optional: true });
  api.registerTool({
    name: "webex_auto_join_status",
    description: "Report Webex auto-join coverage, upcoming meetings, pending joins, active sessions, and sanitized failure codes.",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Optional Webex room ID used to restrict the report to one space." }
      }
    },
    execute: async (_id, args) => toToolResult(
      resolveService().status(String(args?.room_id ?? "").trim() || void 0)
    )
  }, { optional: true });
}
function register(api) {
  if (!api) return validationEntry();
  const mode = api.registrationMode ?? "full";
  if (!["full", "discovery", "tool-discovery"].includes(mode)) return;
  let service = mode === "full" ? getSharedService(api) : void 0;
  const resolveService = () => service ??= getSharedService(api);
  registerTools(api, resolveService);
  if (mode === "tool-discovery") return;
  api.registerHttpRoute({
    path: "/webhooks/webex-auto-join",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => resolveService().handleWebhookRoute(req, res)
  });
  api.registerHttpRoute({
    path: "/webex-auto-join/runner/",
    auth: "plugin",
    match: "prefix",
    handler: (req, res) => resolveService().handleRunnerRoute(req, res)
  });
  if (mode === "full") {
    api.registerService({
      id: "webex-auto-join",
      start: async () => resolveService().start(),
      stop: async () => resolveService().stop()
    });
  }
}
var index_default = register;
export {
  index_default as default,
  getSharedService,
  register
};
