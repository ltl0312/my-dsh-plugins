// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: packages/tlnotify/src/client/*  |  Build: pnpm build:client
// DSH client-module boot registration protocol (see dsh-client-modules).
window.__ModuleLoader__.load({
  id: "dsh-plugin-tlnotify",
  factory: (require) => {
    "use strict";
    var __tlnotify_client_exports = (() => {
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
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, { get: all[name], enumerable: true });
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
      var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/can-promise.js
      var require_can_promise = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/can-promise.js"(exports, module) {
          module.exports = function() {
            return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/utils.js
      var require_utils = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/utils.js"(exports) {
          var toSJISFunction;
          var CODEWORDS_COUNT = [
            0,
            // Not used
            26,
            44,
            70,
            100,
            134,
            172,
            196,
            242,
            292,
            346,
            404,
            466,
            532,
            581,
            655,
            733,
            815,
            901,
            991,
            1085,
            1156,
            1258,
            1364,
            1474,
            1588,
            1706,
            1828,
            1921,
            2051,
            2185,
            2323,
            2465,
            2611,
            2761,
            2876,
            3034,
            3196,
            3362,
            3532,
            3706
          ];
          exports.getSymbolSize = function getSymbolSize(version) {
            if (!version) throw new Error('"version" cannot be null or undefined');
            if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
            return version * 4 + 17;
          };
          exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
            return CODEWORDS_COUNT[version];
          };
          exports.getBCHDigit = function(data) {
            let digit = 0;
            while (data !== 0) {
              digit++;
              data >>>= 1;
            }
            return digit;
          };
          exports.setToSJISFunction = function setToSJISFunction(f) {
            if (typeof f !== "function") {
              throw new Error('"toSJISFunc" is not a valid function.');
            }
            toSJISFunction = f;
          };
          exports.isKanjiModeEnabled = function() {
            return typeof toSJISFunction !== "undefined";
          };
          exports.toSJIS = function toSJIS(kanji) {
            return toSJISFunction(kanji);
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/error-correction-level.js
      var require_error_correction_level = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/error-correction-level.js"(exports) {
          exports.L = { bit: 1 };
          exports.M = { bit: 0 };
          exports.Q = { bit: 3 };
          exports.H = { bit: 2 };
          function fromString(string) {
            if (typeof string !== "string") {
              throw new Error("Param is not a string");
            }
            const lcStr = string.toLowerCase();
            switch (lcStr) {
              case "l":
              case "low":
                return exports.L;
              case "m":
              case "medium":
                return exports.M;
              case "q":
              case "quartile":
                return exports.Q;
              case "h":
              case "high":
                return exports.H;
              default:
                throw new Error("Unknown EC Level: " + string);
            }
          }
          exports.isValid = function isValid(level) {
            return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
          };
          exports.from = function from(value, defaultValue) {
            if (exports.isValid(value)) {
              return value;
            }
            try {
              return fromString(value);
            } catch (e) {
              return defaultValue;
            }
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/bit-buffer.js
      var require_bit_buffer = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/bit-buffer.js"(exports, module) {
          function BitBuffer() {
            this.buffer = [];
            this.length = 0;
          }
          BitBuffer.prototype = {
            get: function(index) {
              const bufIndex = Math.floor(index / 8);
              return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
            },
            put: function(num, length) {
              for (let i = 0; i < length; i++) {
                this.putBit((num >>> length - i - 1 & 1) === 1);
              }
            },
            getLengthInBits: function() {
              return this.length;
            },
            putBit: function(bit) {
              const bufIndex = Math.floor(this.length / 8);
              if (this.buffer.length <= bufIndex) {
                this.buffer.push(0);
              }
              if (bit) {
                this.buffer[bufIndex] |= 128 >>> this.length % 8;
              }
              this.length++;
            }
          };
          module.exports = BitBuffer;
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/bit-matrix.js
      var require_bit_matrix = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/bit-matrix.js"(exports, module) {
          function BitMatrix(size) {
            if (!size || size < 1) {
              throw new Error("BitMatrix size must be defined and greater than 0");
            }
            this.size = size;
            this.data = new Uint8Array(size * size);
            this.reservedBit = new Uint8Array(size * size);
          }
          BitMatrix.prototype.set = function(row, col, value, reserved) {
            const index = row * this.size + col;
            this.data[index] = value;
            if (reserved) this.reservedBit[index] = true;
          };
          BitMatrix.prototype.get = function(row, col) {
            return this.data[row * this.size + col];
          };
          BitMatrix.prototype.xor = function(row, col, value) {
            this.data[row * this.size + col] ^= value;
          };
          BitMatrix.prototype.isReserved = function(row, col) {
            return this.reservedBit[row * this.size + col];
          };
          module.exports = BitMatrix;
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/alignment-pattern.js
      var require_alignment_pattern = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/alignment-pattern.js"(exports) {
          var getSymbolSize = require_utils().getSymbolSize;
          exports.getRowColCoords = function getRowColCoords(version) {
            if (version === 1) return [];
            const posCount = Math.floor(version / 7) + 2;
            const size = getSymbolSize(version);
            const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
            const positions = [size - 7];
            for (let i = 1; i < posCount - 1; i++) {
              positions[i] = positions[i - 1] - intervals;
            }
            positions.push(6);
            return positions.reverse();
          };
          exports.getPositions = function getPositions(version) {
            const coords = [];
            const pos = exports.getRowColCoords(version);
            const posLength = pos.length;
            for (let i = 0; i < posLength; i++) {
              for (let j = 0; j < posLength; j++) {
                if (i === 0 && j === 0 || // top-left
                i === 0 && j === posLength - 1 || // bottom-left
                i === posLength - 1 && j === 0) {
                  continue;
                }
                coords.push([pos[i], pos[j]]);
              }
            }
            return coords;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/finder-pattern.js
      var require_finder_pattern = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/finder-pattern.js"(exports) {
          var getSymbolSize = require_utils().getSymbolSize;
          var FINDER_PATTERN_SIZE = 7;
          exports.getPositions = function getPositions(version) {
            const size = getSymbolSize(version);
            return [
              // top-left
              [0, 0],
              // top-right
              [size - FINDER_PATTERN_SIZE, 0],
              // bottom-left
              [0, size - FINDER_PATTERN_SIZE]
            ];
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/mask-pattern.js
      var require_mask_pattern = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/mask-pattern.js"(exports) {
          exports.Patterns = {
            PATTERN000: 0,
            PATTERN001: 1,
            PATTERN010: 2,
            PATTERN011: 3,
            PATTERN100: 4,
            PATTERN101: 5,
            PATTERN110: 6,
            PATTERN111: 7
          };
          var PenaltyScores = {
            N1: 3,
            N2: 3,
            N3: 40,
            N4: 10
          };
          exports.isValid = function isValid(mask) {
            return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
          };
          exports.from = function from(value) {
            return exports.isValid(value) ? parseInt(value, 10) : void 0;
          };
          exports.getPenaltyN1 = function getPenaltyN1(data) {
            const size = data.size;
            let points = 0;
            let sameCountCol = 0;
            let sameCountRow = 0;
            let lastCol = null;
            let lastRow = null;
            for (let row = 0; row < size; row++) {
              sameCountCol = sameCountRow = 0;
              lastCol = lastRow = null;
              for (let col = 0; col < size; col++) {
                let module2 = data.get(row, col);
                if (module2 === lastCol) {
                  sameCountCol++;
                } else {
                  if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
                  lastCol = module2;
                  sameCountCol = 1;
                }
                module2 = data.get(col, row);
                if (module2 === lastRow) {
                  sameCountRow++;
                } else {
                  if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
                  lastRow = module2;
                  sameCountRow = 1;
                }
              }
              if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
              if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
            }
            return points;
          };
          exports.getPenaltyN2 = function getPenaltyN2(data) {
            const size = data.size;
            let points = 0;
            for (let row = 0; row < size - 1; row++) {
              for (let col = 0; col < size - 1; col++) {
                const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
                if (last === 4 || last === 0) points++;
              }
            }
            return points * PenaltyScores.N2;
          };
          exports.getPenaltyN3 = function getPenaltyN3(data) {
            const size = data.size;
            let points = 0;
            let bitsCol = 0;
            let bitsRow = 0;
            for (let row = 0; row < size; row++) {
              bitsCol = bitsRow = 0;
              for (let col = 0; col < size; col++) {
                bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
                if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
                bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
                if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
              }
            }
            return points * PenaltyScores.N3;
          };
          exports.getPenaltyN4 = function getPenaltyN4(data) {
            let darkCount = 0;
            const modulesCount = data.data.length;
            for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
            const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
            return k * PenaltyScores.N4;
          };
          function getMaskAt(maskPattern, i, j) {
            switch (maskPattern) {
              case exports.Patterns.PATTERN000:
                return (i + j) % 2 === 0;
              case exports.Patterns.PATTERN001:
                return i % 2 === 0;
              case exports.Patterns.PATTERN010:
                return j % 3 === 0;
              case exports.Patterns.PATTERN011:
                return (i + j) % 3 === 0;
              case exports.Patterns.PATTERN100:
                return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
              case exports.Patterns.PATTERN101:
                return i * j % 2 + i * j % 3 === 0;
              case exports.Patterns.PATTERN110:
                return (i * j % 2 + i * j % 3) % 2 === 0;
              case exports.Patterns.PATTERN111:
                return (i * j % 3 + (i + j) % 2) % 2 === 0;
              default:
                throw new Error("bad maskPattern:" + maskPattern);
            }
          }
          exports.applyMask = function applyMask(pattern, data) {
            const size = data.size;
            for (let col = 0; col < size; col++) {
              for (let row = 0; row < size; row++) {
                if (data.isReserved(row, col)) continue;
                data.xor(row, col, getMaskAt(pattern, row, col));
              }
            }
          };
          exports.getBestMask = function getBestMask(data, setupFormatFunc) {
            const numPatterns = Object.keys(exports.Patterns).length;
            let bestPattern = 0;
            let lowerPenalty = Infinity;
            for (let p = 0; p < numPatterns; p++) {
              setupFormatFunc(p);
              exports.applyMask(p, data);
              const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
              exports.applyMask(p, data);
              if (penalty < lowerPenalty) {
                lowerPenalty = penalty;
                bestPattern = p;
              }
            }
            return bestPattern;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/error-correction-code.js
      var require_error_correction_code = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/error-correction-code.js"(exports) {
          var ECLevel = require_error_correction_level();
          var EC_BLOCKS_TABLE = [
            // L  M  Q  H
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
            2,
            2,
            1,
            2,
            2,
            4,
            1,
            2,
            4,
            4,
            2,
            4,
            4,
            4,
            2,
            4,
            6,
            5,
            2,
            4,
            6,
            6,
            2,
            5,
            8,
            8,
            4,
            5,
            8,
            8,
            4,
            5,
            8,
            11,
            4,
            8,
            10,
            11,
            4,
            9,
            12,
            16,
            4,
            9,
            16,
            16,
            6,
            10,
            12,
            18,
            6,
            10,
            17,
            16,
            6,
            11,
            16,
            19,
            6,
            13,
            18,
            21,
            7,
            14,
            21,
            25,
            8,
            16,
            20,
            25,
            8,
            17,
            23,
            25,
            9,
            17,
            23,
            34,
            9,
            18,
            25,
            30,
            10,
            20,
            27,
            32,
            12,
            21,
            29,
            35,
            12,
            23,
            34,
            37,
            12,
            25,
            34,
            40,
            13,
            26,
            35,
            42,
            14,
            28,
            38,
            45,
            15,
            29,
            40,
            48,
            16,
            31,
            43,
            51,
            17,
            33,
            45,
            54,
            18,
            35,
            48,
            57,
            19,
            37,
            51,
            60,
            19,
            38,
            53,
            63,
            20,
            40,
            56,
            66,
            21,
            43,
            59,
            70,
            22,
            45,
            62,
            74,
            24,
            47,
            65,
            77,
            25,
            49,
            68,
            81
          ];
          var EC_CODEWORDS_TABLE = [
            // L  M  Q  H
            7,
            10,
            13,
            17,
            10,
            16,
            22,
            28,
            15,
            26,
            36,
            44,
            20,
            36,
            52,
            64,
            26,
            48,
            72,
            88,
            36,
            64,
            96,
            112,
            40,
            72,
            108,
            130,
            48,
            88,
            132,
            156,
            60,
            110,
            160,
            192,
            72,
            130,
            192,
            224,
            80,
            150,
            224,
            264,
            96,
            176,
            260,
            308,
            104,
            198,
            288,
            352,
            120,
            216,
            320,
            384,
            132,
            240,
            360,
            432,
            144,
            280,
            408,
            480,
            168,
            308,
            448,
            532,
            180,
            338,
            504,
            588,
            196,
            364,
            546,
            650,
            224,
            416,
            600,
            700,
            224,
            442,
            644,
            750,
            252,
            476,
            690,
            816,
            270,
            504,
            750,
            900,
            300,
            560,
            810,
            960,
            312,
            588,
            870,
            1050,
            336,
            644,
            952,
            1110,
            360,
            700,
            1020,
            1200,
            390,
            728,
            1050,
            1260,
            420,
            784,
            1140,
            1350,
            450,
            812,
            1200,
            1440,
            480,
            868,
            1290,
            1530,
            510,
            924,
            1350,
            1620,
            540,
            980,
            1440,
            1710,
            570,
            1036,
            1530,
            1800,
            570,
            1064,
            1590,
            1890,
            600,
            1120,
            1680,
            1980,
            630,
            1204,
            1770,
            2100,
            660,
            1260,
            1860,
            2220,
            720,
            1316,
            1950,
            2310,
            750,
            1372,
            2040,
            2430
          ];
          exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
            switch (errorCorrectionLevel) {
              case ECLevel.L:
                return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
              case ECLevel.M:
                return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
              case ECLevel.Q:
                return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
              case ECLevel.H:
                return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
              default:
                return void 0;
            }
          };
          exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
            switch (errorCorrectionLevel) {
              case ECLevel.L:
                return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
              case ECLevel.M:
                return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
              case ECLevel.Q:
                return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
              case ECLevel.H:
                return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
              default:
                return void 0;
            }
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/galois-field.js
      var require_galois_field = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/galois-field.js"(exports) {
          var EXP_TABLE = new Uint8Array(512);
          var LOG_TABLE = new Uint8Array(256);
          (function initTables() {
            let x = 1;
            for (let i = 0; i < 255; i++) {
              EXP_TABLE[i] = x;
              LOG_TABLE[x] = i;
              x <<= 1;
              if (x & 256) {
                x ^= 285;
              }
            }
            for (let i = 255; i < 512; i++) {
              EXP_TABLE[i] = EXP_TABLE[i - 255];
            }
          })();
          exports.log = function log(n) {
            if (n < 1) throw new Error("log(" + n + ")");
            return LOG_TABLE[n];
          };
          exports.exp = function exp(n) {
            return EXP_TABLE[n];
          };
          exports.mul = function mul(x, y) {
            if (x === 0 || y === 0) return 0;
            return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/polynomial.js
      var require_polynomial = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/polynomial.js"(exports) {
          var GF = require_galois_field();
          exports.mul = function mul(p1, p2) {
            const coeff = new Uint8Array(p1.length + p2.length - 1);
            for (let i = 0; i < p1.length; i++) {
              for (let j = 0; j < p2.length; j++) {
                coeff[i + j] ^= GF.mul(p1[i], p2[j]);
              }
            }
            return coeff;
          };
          exports.mod = function mod(divident, divisor) {
            let result = new Uint8Array(divident);
            while (result.length - divisor.length >= 0) {
              const coeff = result[0];
              for (let i = 0; i < divisor.length; i++) {
                result[i] ^= GF.mul(divisor[i], coeff);
              }
              let offset = 0;
              while (offset < result.length && result[offset] === 0) offset++;
              result = result.slice(offset);
            }
            return result;
          };
          exports.generateECPolynomial = function generateECPolynomial(degree) {
            let poly = new Uint8Array([1]);
            for (let i = 0; i < degree; i++) {
              poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
            }
            return poly;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/reed-solomon-encoder.js
      var require_reed_solomon_encoder = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports, module) {
          var Polynomial = require_polynomial();
          function ReedSolomonEncoder(degree) {
            this.genPoly = void 0;
            this.degree = degree;
            if (this.degree) this.initialize(this.degree);
          }
          ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
            this.degree = degree;
            this.genPoly = Polynomial.generateECPolynomial(this.degree);
          };
          ReedSolomonEncoder.prototype.encode = function encode(data) {
            if (!this.genPoly) {
              throw new Error("Encoder not initialized");
            }
            const paddedData = new Uint8Array(data.length + this.degree);
            paddedData.set(data);
            const remainder = Polynomial.mod(paddedData, this.genPoly);
            const start = this.degree - remainder.length;
            if (start > 0) {
              const buff = new Uint8Array(this.degree);
              buff.set(remainder, start);
              return buff;
            }
            return remainder;
          };
          module.exports = ReedSolomonEncoder;
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/version-check.js
      var require_version_check = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/version-check.js"(exports) {
          exports.isValid = function isValid(version) {
            return !isNaN(version) && version >= 1 && version <= 40;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/regex.js
      var require_regex = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/regex.js"(exports) {
          var numeric = "[0-9]+";
          var alphanumeric = "[A-Z $%*+\\-./:]+";
          var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
          kanji = kanji.replace(/u/g, "\\u");
          var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
          exports.KANJI = new RegExp(kanji, "g");
          exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
          exports.BYTE = new RegExp(byte, "g");
          exports.NUMERIC = new RegExp(numeric, "g");
          exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
          var TEST_KANJI = new RegExp("^" + kanji + "$");
          var TEST_NUMERIC = new RegExp("^" + numeric + "$");
          var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
          exports.testKanji = function testKanji(str) {
            return TEST_KANJI.test(str);
          };
          exports.testNumeric = function testNumeric(str) {
            return TEST_NUMERIC.test(str);
          };
          exports.testAlphanumeric = function testAlphanumeric(str) {
            return TEST_ALPHANUMERIC.test(str);
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/mode.js
      var require_mode = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/mode.js"(exports) {
          var VersionCheck = require_version_check();
          var Regex = require_regex();
          exports.NUMERIC = {
            id: "Numeric",
            bit: 1 << 0,
            ccBits: [10, 12, 14]
          };
          exports.ALPHANUMERIC = {
            id: "Alphanumeric",
            bit: 1 << 1,
            ccBits: [9, 11, 13]
          };
          exports.BYTE = {
            id: "Byte",
            bit: 1 << 2,
            ccBits: [8, 16, 16]
          };
          exports.KANJI = {
            id: "Kanji",
            bit: 1 << 3,
            ccBits: [8, 10, 12]
          };
          exports.MIXED = {
            bit: -1
          };
          exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
            if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
            if (!VersionCheck.isValid(version)) {
              throw new Error("Invalid version: " + version);
            }
            if (version >= 1 && version < 10) return mode.ccBits[0];
            else if (version < 27) return mode.ccBits[1];
            return mode.ccBits[2];
          };
          exports.getBestModeForData = function getBestModeForData(dataStr) {
            if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
            else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
            else if (Regex.testKanji(dataStr)) return exports.KANJI;
            else return exports.BYTE;
          };
          exports.toString = function toString(mode) {
            if (mode && mode.id) return mode.id;
            throw new Error("Invalid mode");
          };
          exports.isValid = function isValid(mode) {
            return mode && mode.bit && mode.ccBits;
          };
          function fromString(string) {
            if (typeof string !== "string") {
              throw new Error("Param is not a string");
            }
            const lcStr = string.toLowerCase();
            switch (lcStr) {
              case "numeric":
                return exports.NUMERIC;
              case "alphanumeric":
                return exports.ALPHANUMERIC;
              case "kanji":
                return exports.KANJI;
              case "byte":
                return exports.BYTE;
              default:
                throw new Error("Unknown mode: " + string);
            }
          }
          exports.from = function from(value, defaultValue) {
            if (exports.isValid(value)) {
              return value;
            }
            try {
              return fromString(value);
            } catch (e) {
              return defaultValue;
            }
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/version.js
      var require_version = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/version.js"(exports) {
          var Utils = require_utils();
          var ECCode = require_error_correction_code();
          var ECLevel = require_error_correction_level();
          var Mode = require_mode();
          var VersionCheck = require_version_check();
          var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
          var G18_BCH = Utils.getBCHDigit(G18);
          function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
            for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
              if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
                return currentVersion;
              }
            }
            return void 0;
          }
          function getReservedBitsCount(mode, version) {
            return Mode.getCharCountIndicator(mode, version) + 4;
          }
          function getTotalBitsFromDataArray(segments, version) {
            let totalBits = 0;
            segments.forEach(function(data) {
              const reservedBits = getReservedBitsCount(data.mode, version);
              totalBits += reservedBits + data.getBitsLength();
            });
            return totalBits;
          }
          function getBestVersionForMixedData(segments, errorCorrectionLevel) {
            for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
              const length = getTotalBitsFromDataArray(segments, currentVersion);
              if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
                return currentVersion;
              }
            }
            return void 0;
          }
          exports.from = function from(value, defaultValue) {
            if (VersionCheck.isValid(value)) {
              return parseInt(value, 10);
            }
            return defaultValue;
          };
          exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
            if (!VersionCheck.isValid(version)) {
              throw new Error("Invalid QR Code version");
            }
            if (typeof mode === "undefined") mode = Mode.BYTE;
            const totalCodewords = Utils.getSymbolTotalCodewords(version);
            const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
            const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
            if (mode === Mode.MIXED) return dataTotalCodewordsBits;
            const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
            switch (mode) {
              case Mode.NUMERIC:
                return Math.floor(usableBits / 10 * 3);
              case Mode.ALPHANUMERIC:
                return Math.floor(usableBits / 11 * 2);
              case Mode.KANJI:
                return Math.floor(usableBits / 13);
              case Mode.BYTE:
              default:
                return Math.floor(usableBits / 8);
            }
          };
          exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
            let seg;
            const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
            if (Array.isArray(data)) {
              if (data.length > 1) {
                return getBestVersionForMixedData(data, ecl);
              }
              if (data.length === 0) {
                return 1;
              }
              seg = data[0];
            } else {
              seg = data;
            }
            return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
          };
          exports.getEncodedBits = function getEncodedBits(version) {
            if (!VersionCheck.isValid(version) || version < 7) {
              throw new Error("Invalid QR Code version");
            }
            let d = version << 12;
            while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
              d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
            }
            return version << 12 | d;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/format-info.js
      var require_format_info = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/format-info.js"(exports) {
          var Utils = require_utils();
          var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
          var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
          var G15_BCH = Utils.getBCHDigit(G15);
          exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
            const data = errorCorrectionLevel.bit << 3 | mask;
            let d = data << 10;
            while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
              d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
            }
            return (data << 10 | d) ^ G15_MASK;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/numeric-data.js
      var require_numeric_data = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/numeric-data.js"(exports, module) {
          var Mode = require_mode();
          function NumericData(data) {
            this.mode = Mode.NUMERIC;
            this.data = data.toString();
          }
          NumericData.getBitsLength = function getBitsLength(length) {
            return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
          };
          NumericData.prototype.getLength = function getLength() {
            return this.data.length;
          };
          NumericData.prototype.getBitsLength = function getBitsLength() {
            return NumericData.getBitsLength(this.data.length);
          };
          NumericData.prototype.write = function write(bitBuffer) {
            let i, group, value;
            for (i = 0; i + 3 <= this.data.length; i += 3) {
              group = this.data.substr(i, 3);
              value = parseInt(group, 10);
              bitBuffer.put(value, 10);
            }
            const remainingNum = this.data.length - i;
            if (remainingNum > 0) {
              group = this.data.substr(i);
              value = parseInt(group, 10);
              bitBuffer.put(value, remainingNum * 3 + 1);
            }
          };
          module.exports = NumericData;
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/alphanumeric-data.js
      var require_alphanumeric_data = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/alphanumeric-data.js"(exports, module) {
          var Mode = require_mode();
          var ALPHA_NUM_CHARS = [
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "A",
            "B",
            "C",
            "D",
            "E",
            "F",
            "G",
            "H",
            "I",
            "J",
            "K",
            "L",
            "M",
            "N",
            "O",
            "P",
            "Q",
            "R",
            "S",
            "T",
            "U",
            "V",
            "W",
            "X",
            "Y",
            "Z",
            " ",
            "$",
            "%",
            "*",
            "+",
            "-",
            ".",
            "/",
            ":"
          ];
          function AlphanumericData(data) {
            this.mode = Mode.ALPHANUMERIC;
            this.data = data;
          }
          AlphanumericData.getBitsLength = function getBitsLength(length) {
            return 11 * Math.floor(length / 2) + 6 * (length % 2);
          };
          AlphanumericData.prototype.getLength = function getLength() {
            return this.data.length;
          };
          AlphanumericData.prototype.getBitsLength = function getBitsLength() {
            return AlphanumericData.getBitsLength(this.data.length);
          };
          AlphanumericData.prototype.write = function write(bitBuffer) {
            let i;
            for (i = 0; i + 2 <= this.data.length; i += 2) {
              let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
              value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
              bitBuffer.put(value, 11);
            }
            if (this.data.length % 2) {
              bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
            }
          };
          module.exports = AlphanumericData;
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/byte-data.js
      var require_byte_data = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/byte-data.js"(exports, module) {
          var Mode = require_mode();
          function ByteData(data) {
            this.mode = Mode.BYTE;
            if (typeof data === "string") {
              this.data = new TextEncoder().encode(data);
            } else {
              this.data = new Uint8Array(data);
            }
          }
          ByteData.getBitsLength = function getBitsLength(length) {
            return length * 8;
          };
          ByteData.prototype.getLength = function getLength() {
            return this.data.length;
          };
          ByteData.prototype.getBitsLength = function getBitsLength() {
            return ByteData.getBitsLength(this.data.length);
          };
          ByteData.prototype.write = function(bitBuffer) {
            for (let i = 0, l = this.data.length; i < l; i++) {
              bitBuffer.put(this.data[i], 8);
            }
          };
          module.exports = ByteData;
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/kanji-data.js
      var require_kanji_data = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/kanji-data.js"(exports, module) {
          var Mode = require_mode();
          var Utils = require_utils();
          function KanjiData(data) {
            this.mode = Mode.KANJI;
            this.data = data;
          }
          KanjiData.getBitsLength = function getBitsLength(length) {
            return length * 13;
          };
          KanjiData.prototype.getLength = function getLength() {
            return this.data.length;
          };
          KanjiData.prototype.getBitsLength = function getBitsLength() {
            return KanjiData.getBitsLength(this.data.length);
          };
          KanjiData.prototype.write = function(bitBuffer) {
            let i;
            for (i = 0; i < this.data.length; i++) {
              let value = Utils.toSJIS(this.data[i]);
              if (value >= 33088 && value <= 40956) {
                value -= 33088;
              } else if (value >= 57408 && value <= 60351) {
                value -= 49472;
              } else {
                throw new Error(
                  "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
                );
              }
              value = (value >>> 8 & 255) * 192 + (value & 255);
              bitBuffer.put(value, 13);
            }
          };
          module.exports = KanjiData;
        }
      });
    
      // ../../node_modules/.pnpm/dijkstrajs@1.0.3/node_modules/dijkstrajs/dijkstra.js
      var require_dijkstra = __commonJS({
        "../../node_modules/.pnpm/dijkstrajs@1.0.3/node_modules/dijkstrajs/dijkstra.js"(exports, module) {
          "use strict";
          var dijkstra = {
            single_source_shortest_paths: function(graph, s, d) {
              var predecessors = {};
              var costs = {};
              costs[s] = 0;
              var open = dijkstra.PriorityQueue.make();
              open.push(s, 0);
              var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
              while (!open.empty()) {
                closest = open.pop();
                u = closest.value;
                cost_of_s_to_u = closest.cost;
                adjacent_nodes = graph[u] || {};
                for (v in adjacent_nodes) {
                  if (adjacent_nodes.hasOwnProperty(v)) {
                    cost_of_e = adjacent_nodes[v];
                    cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
                    cost_of_s_to_v = costs[v];
                    first_visit = typeof costs[v] === "undefined";
                    if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                      costs[v] = cost_of_s_to_u_plus_cost_of_e;
                      open.push(v, cost_of_s_to_u_plus_cost_of_e);
                      predecessors[v] = u;
                    }
                  }
                }
              }
              if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
                var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
                throw new Error(msg);
              }
              return predecessors;
            },
            extract_shortest_path_from_predecessor_list: function(predecessors, d) {
              var nodes = [];
              var u = d;
              var predecessor;
              while (u) {
                nodes.push(u);
                predecessor = predecessors[u];
                u = predecessors[u];
              }
              nodes.reverse();
              return nodes;
            },
            find_path: function(graph, s, d) {
              var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
              return dijkstra.extract_shortest_path_from_predecessor_list(
                predecessors,
                d
              );
            },
            /**
             * A very naive priority queue implementation.
             */
            PriorityQueue: {
              make: function(opts) {
                var T = dijkstra.PriorityQueue, t = {}, key;
                opts = opts || {};
                for (key in T) {
                  if (T.hasOwnProperty(key)) {
                    t[key] = T[key];
                  }
                }
                t.queue = [];
                t.sorter = opts.sorter || T.default_sorter;
                return t;
              },
              default_sorter: function(a, b) {
                return a.cost - b.cost;
              },
              /**
               * Add a new item to the queue and ensure the highest priority element
               * is at the front of the queue.
               */
              push: function(value, cost) {
                var item = { value, cost };
                this.queue.push(item);
                this.queue.sort(this.sorter);
              },
              /**
               * Return the highest priority element in the queue.
               */
              pop: function() {
                return this.queue.shift();
              },
              empty: function() {
                return this.queue.length === 0;
              }
            }
          };
          if (typeof module !== "undefined") {
            module.exports = dijkstra;
          }
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/segments.js
      var require_segments = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/segments.js"(exports) {
          var Mode = require_mode();
          var NumericData = require_numeric_data();
          var AlphanumericData = require_alphanumeric_data();
          var ByteData = require_byte_data();
          var KanjiData = require_kanji_data();
          var Regex = require_regex();
          var Utils = require_utils();
          var dijkstra = require_dijkstra();
          function getStringByteLength(str) {
            return unescape(encodeURIComponent(str)).length;
          }
          function getSegments(regex, mode, str) {
            const segments = [];
            let result;
            while ((result = regex.exec(str)) !== null) {
              segments.push({
                data: result[0],
                index: result.index,
                mode,
                length: result[0].length
              });
            }
            return segments;
          }
          function getSegmentsFromString(dataStr) {
            const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
            const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
            let byteSegs;
            let kanjiSegs;
            if (Utils.isKanjiModeEnabled()) {
              byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
              kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
            } else {
              byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
              kanjiSegs = [];
            }
            const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
            return segs.sort(function(s1, s2) {
              return s1.index - s2.index;
            }).map(function(obj) {
              return {
                data: obj.data,
                mode: obj.mode,
                length: obj.length
              };
            });
          }
          function getSegmentBitsLength(length, mode) {
            switch (mode) {
              case Mode.NUMERIC:
                return NumericData.getBitsLength(length);
              case Mode.ALPHANUMERIC:
                return AlphanumericData.getBitsLength(length);
              case Mode.KANJI:
                return KanjiData.getBitsLength(length);
              case Mode.BYTE:
                return ByteData.getBitsLength(length);
            }
          }
          function mergeSegments(segs) {
            return segs.reduce(function(acc, curr) {
              const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
              if (prevSeg && prevSeg.mode === curr.mode) {
                acc[acc.length - 1].data += curr.data;
                return acc;
              }
              acc.push(curr);
              return acc;
            }, []);
          }
          function buildNodes(segs) {
            const nodes = [];
            for (let i = 0; i < segs.length; i++) {
              const seg = segs[i];
              switch (seg.mode) {
                case Mode.NUMERIC:
                  nodes.push([
                    seg,
                    { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
                    { data: seg.data, mode: Mode.BYTE, length: seg.length }
                  ]);
                  break;
                case Mode.ALPHANUMERIC:
                  nodes.push([
                    seg,
                    { data: seg.data, mode: Mode.BYTE, length: seg.length }
                  ]);
                  break;
                case Mode.KANJI:
                  nodes.push([
                    seg,
                    { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
                  ]);
                  break;
                case Mode.BYTE:
                  nodes.push([
                    { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
                  ]);
              }
            }
            return nodes;
          }
          function buildGraph(nodes, version) {
            const table = {};
            const graph = { start: {} };
            let prevNodeIds = ["start"];
            for (let i = 0; i < nodes.length; i++) {
              const nodeGroup = nodes[i];
              const currentNodeIds = [];
              for (let j = 0; j < nodeGroup.length; j++) {
                const node = nodeGroup[j];
                const key = "" + i + j;
                currentNodeIds.push(key);
                table[key] = { node, lastCount: 0 };
                graph[key] = {};
                for (let n = 0; n < prevNodeIds.length; n++) {
                  const prevNodeId = prevNodeIds[n];
                  if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
                    graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
                    table[prevNodeId].lastCount += node.length;
                  } else {
                    if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
                    graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
                  }
                }
              }
              prevNodeIds = currentNodeIds;
            }
            for (let n = 0; n < prevNodeIds.length; n++) {
              graph[prevNodeIds[n]].end = 0;
            }
            return { map: graph, table };
          }
          function buildSingleSegment(data, modesHint) {
            let mode;
            const bestMode = Mode.getBestModeForData(data);
            mode = Mode.from(modesHint, bestMode);
            if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
              throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
            }
            if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
              mode = Mode.BYTE;
            }
            switch (mode) {
              case Mode.NUMERIC:
                return new NumericData(data);
              case Mode.ALPHANUMERIC:
                return new AlphanumericData(data);
              case Mode.KANJI:
                return new KanjiData(data);
              case Mode.BYTE:
                return new ByteData(data);
            }
          }
          exports.fromArray = function fromArray(array) {
            return array.reduce(function(acc, seg) {
              if (typeof seg === "string") {
                acc.push(buildSingleSegment(seg, null));
              } else if (seg.data) {
                acc.push(buildSingleSegment(seg.data, seg.mode));
              }
              return acc;
            }, []);
          };
          exports.fromString = function fromString(data, version) {
            const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
            const nodes = buildNodes(segs);
            const graph = buildGraph(nodes, version);
            const path = dijkstra.find_path(graph.map, "start", "end");
            const optimizedSegs = [];
            for (let i = 1; i < path.length - 1; i++) {
              optimizedSegs.push(graph.table[path[i]].node);
            }
            return exports.fromArray(mergeSegments(optimizedSegs));
          };
          exports.rawSplit = function rawSplit(data) {
            return exports.fromArray(
              getSegmentsFromString(data, Utils.isKanjiModeEnabled())
            );
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/qrcode.js
      var require_qrcode = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/core/qrcode.js"(exports) {
          var Utils = require_utils();
          var ECLevel = require_error_correction_level();
          var BitBuffer = require_bit_buffer();
          var BitMatrix = require_bit_matrix();
          var AlignmentPattern = require_alignment_pattern();
          var FinderPattern = require_finder_pattern();
          var MaskPattern = require_mask_pattern();
          var ECCode = require_error_correction_code();
          var ReedSolomonEncoder = require_reed_solomon_encoder();
          var Version = require_version();
          var FormatInfo = require_format_info();
          var Mode = require_mode();
          var Segments = require_segments();
          function setupFinderPattern(matrix, version) {
            const size = matrix.size;
            const pos = FinderPattern.getPositions(version);
            for (let i = 0; i < pos.length; i++) {
              const row = pos[i][0];
              const col = pos[i][1];
              for (let r = -1; r <= 7; r++) {
                if (row + r <= -1 || size <= row + r) continue;
                for (let c = -1; c <= 7; c++) {
                  if (col + c <= -1 || size <= col + c) continue;
                  if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
                    matrix.set(row + r, col + c, true, true);
                  } else {
                    matrix.set(row + r, col + c, false, true);
                  }
                }
              }
            }
          }
          function setupTimingPattern(matrix) {
            const size = matrix.size;
            for (let r = 8; r < size - 8; r++) {
              const value = r % 2 === 0;
              matrix.set(r, 6, value, true);
              matrix.set(6, r, value, true);
            }
          }
          function setupAlignmentPattern(matrix, version) {
            const pos = AlignmentPattern.getPositions(version);
            for (let i = 0; i < pos.length; i++) {
              const row = pos[i][0];
              const col = pos[i][1];
              for (let r = -2; r <= 2; r++) {
                for (let c = -2; c <= 2; c++) {
                  if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
                    matrix.set(row + r, col + c, true, true);
                  } else {
                    matrix.set(row + r, col + c, false, true);
                  }
                }
              }
            }
          }
          function setupVersionInfo(matrix, version) {
            const size = matrix.size;
            const bits = Version.getEncodedBits(version);
            let row, col, mod;
            for (let i = 0; i < 18; i++) {
              row = Math.floor(i / 3);
              col = i % 3 + size - 8 - 3;
              mod = (bits >> i & 1) === 1;
              matrix.set(row, col, mod, true);
              matrix.set(col, row, mod, true);
            }
          }
          function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
            const size = matrix.size;
            const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
            let i, mod;
            for (i = 0; i < 15; i++) {
              mod = (bits >> i & 1) === 1;
              if (i < 6) {
                matrix.set(i, 8, mod, true);
              } else if (i < 8) {
                matrix.set(i + 1, 8, mod, true);
              } else {
                matrix.set(size - 15 + i, 8, mod, true);
              }
              if (i < 8) {
                matrix.set(8, size - i - 1, mod, true);
              } else if (i < 9) {
                matrix.set(8, 15 - i - 1 + 1, mod, true);
              } else {
                matrix.set(8, 15 - i - 1, mod, true);
              }
            }
            matrix.set(size - 8, 8, 1, true);
          }
          function setupData(matrix, data) {
            const size = matrix.size;
            let inc = -1;
            let row = size - 1;
            let bitIndex = 7;
            let byteIndex = 0;
            for (let col = size - 1; col > 0; col -= 2) {
              if (col === 6) col--;
              while (true) {
                for (let c = 0; c < 2; c++) {
                  if (!matrix.isReserved(row, col - c)) {
                    let dark = false;
                    if (byteIndex < data.length) {
                      dark = (data[byteIndex] >>> bitIndex & 1) === 1;
                    }
                    matrix.set(row, col - c, dark);
                    bitIndex--;
                    if (bitIndex === -1) {
                      byteIndex++;
                      bitIndex = 7;
                    }
                  }
                }
                row += inc;
                if (row < 0 || size <= row) {
                  row -= inc;
                  inc = -inc;
                  break;
                }
              }
            }
          }
          function createData(version, errorCorrectionLevel, segments) {
            const buffer = new BitBuffer();
            segments.forEach(function(data) {
              buffer.put(data.mode.bit, 4);
              buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
              data.write(buffer);
            });
            const totalCodewords = Utils.getSymbolTotalCodewords(version);
            const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
            const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
            if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
              buffer.put(0, 4);
            }
            while (buffer.getLengthInBits() % 8 !== 0) {
              buffer.putBit(0);
            }
            const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
            for (let i = 0; i < remainingByte; i++) {
              buffer.put(i % 2 ? 17 : 236, 8);
            }
            return createCodewords(buffer, version, errorCorrectionLevel);
          }
          function createCodewords(bitBuffer, version, errorCorrectionLevel) {
            const totalCodewords = Utils.getSymbolTotalCodewords(version);
            const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
            const dataTotalCodewords = totalCodewords - ecTotalCodewords;
            const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
            const blocksInGroup2 = totalCodewords % ecTotalBlocks;
            const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
            const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
            const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
            const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
            const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
            const rs = new ReedSolomonEncoder(ecCount);
            let offset = 0;
            const dcData = new Array(ecTotalBlocks);
            const ecData = new Array(ecTotalBlocks);
            let maxDataSize = 0;
            const buffer = new Uint8Array(bitBuffer.buffer);
            for (let b = 0; b < ecTotalBlocks; b++) {
              const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
              dcData[b] = buffer.slice(offset, offset + dataSize);
              ecData[b] = rs.encode(dcData[b]);
              offset += dataSize;
              maxDataSize = Math.max(maxDataSize, dataSize);
            }
            const data = new Uint8Array(totalCodewords);
            let index = 0;
            let i, r;
            for (i = 0; i < maxDataSize; i++) {
              for (r = 0; r < ecTotalBlocks; r++) {
                if (i < dcData[r].length) {
                  data[index++] = dcData[r][i];
                }
              }
            }
            for (i = 0; i < ecCount; i++) {
              for (r = 0; r < ecTotalBlocks; r++) {
                data[index++] = ecData[r][i];
              }
            }
            return data;
          }
          function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
            let segments;
            if (Array.isArray(data)) {
              segments = Segments.fromArray(data);
            } else if (typeof data === "string") {
              let estimatedVersion = version;
              if (!estimatedVersion) {
                const rawSegments = Segments.rawSplit(data);
                estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
              }
              segments = Segments.fromString(data, estimatedVersion || 40);
            } else {
              throw new Error("Invalid data");
            }
            const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
            if (!bestVersion) {
              throw new Error("The amount of data is too big to be stored in a QR Code");
            }
            if (!version) {
              version = bestVersion;
            } else if (version < bestVersion) {
              throw new Error(
                "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
              );
            }
            const dataBits = createData(version, errorCorrectionLevel, segments);
            const moduleCount = Utils.getSymbolSize(version);
            const modules = new BitMatrix(moduleCount);
            setupFinderPattern(modules, version);
            setupTimingPattern(modules);
            setupAlignmentPattern(modules, version);
            setupFormatInfo(modules, errorCorrectionLevel, 0);
            if (version >= 7) {
              setupVersionInfo(modules, version);
            }
            setupData(modules, dataBits);
            if (isNaN(maskPattern)) {
              maskPattern = MaskPattern.getBestMask(
                modules,
                setupFormatInfo.bind(null, modules, errorCorrectionLevel)
              );
            }
            MaskPattern.applyMask(maskPattern, modules);
            setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
            return {
              modules,
              version,
              errorCorrectionLevel,
              maskPattern,
              segments
            };
          }
          exports.create = function create(data, options) {
            if (typeof data === "undefined" || data === "") {
              throw new Error("No input text");
            }
            let errorCorrectionLevel = ECLevel.M;
            let version;
            let mask;
            if (typeof options !== "undefined") {
              errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
              version = Version.from(options.version);
              mask = MaskPattern.from(options.maskPattern);
              if (options.toSJISFunc) {
                Utils.setToSJISFunction(options.toSJISFunc);
              }
            }
            return createSymbol(data, version, errorCorrectionLevel, mask);
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/renderer/utils.js
      var require_utils2 = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/renderer/utils.js"(exports) {
          function hex2rgba(hex) {
            if (typeof hex === "number") {
              hex = hex.toString();
            }
            if (typeof hex !== "string") {
              throw new Error("Color should be defined as hex string");
            }
            let hexCode = hex.slice().replace("#", "").split("");
            if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
              throw new Error("Invalid hex color: " + hex);
            }
            if (hexCode.length === 3 || hexCode.length === 4) {
              hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
                return [c, c];
              }));
            }
            if (hexCode.length === 6) hexCode.push("F", "F");
            const hexValue = parseInt(hexCode.join(""), 16);
            return {
              r: hexValue >> 24 & 255,
              g: hexValue >> 16 & 255,
              b: hexValue >> 8 & 255,
              a: hexValue & 255,
              hex: "#" + hexCode.slice(0, 6).join("")
            };
          }
          exports.getOptions = function getOptions(options) {
            if (!options) options = {};
            if (!options.color) options.color = {};
            const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
            const width = options.width && options.width >= 21 ? options.width : void 0;
            const scale = options.scale || 4;
            return {
              width,
              scale: width ? 4 : scale,
              margin,
              color: {
                dark: hex2rgba(options.color.dark || "#000000ff"),
                light: hex2rgba(options.color.light || "#ffffffff")
              },
              type: options.type,
              rendererOpts: options.rendererOpts || {}
            };
          };
          exports.getScale = function getScale(qrSize, opts) {
            return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
          };
          exports.getImageWidth = function getImageWidth(qrSize, opts) {
            const scale = exports.getScale(qrSize, opts);
            return Math.floor((qrSize + opts.margin * 2) * scale);
          };
          exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
            const size = qr.modules.size;
            const data = qr.modules.data;
            const scale = exports.getScale(size, opts);
            const symbolSize = Math.floor((size + opts.margin * 2) * scale);
            const scaledMargin = opts.margin * scale;
            const palette = [opts.color.light, opts.color.dark];
            for (let i = 0; i < symbolSize; i++) {
              for (let j = 0; j < symbolSize; j++) {
                let posDst = (i * symbolSize + j) * 4;
                let pxColor = opts.color.light;
                if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
                  const iSrc = Math.floor((i - scaledMargin) / scale);
                  const jSrc = Math.floor((j - scaledMargin) / scale);
                  pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
                }
                imgData[posDst++] = pxColor.r;
                imgData[posDst++] = pxColor.g;
                imgData[posDst++] = pxColor.b;
                imgData[posDst] = pxColor.a;
              }
            }
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/renderer/canvas.js
      var require_canvas = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/renderer/canvas.js"(exports) {
          var Utils = require_utils2();
          function clearCanvas(ctx, canvas, size) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (!canvas.style) canvas.style = {};
            canvas.height = size;
            canvas.width = size;
            canvas.style.height = size + "px";
            canvas.style.width = size + "px";
          }
          function getCanvasElement() {
            try {
              return document.createElement("canvas");
            } catch (e) {
              throw new Error("You need to specify a canvas element");
            }
          }
          exports.render = function render(qrData, canvas, options) {
            let opts = options;
            let canvasEl = canvas;
            if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
              opts = canvas;
              canvas = void 0;
            }
            if (!canvas) {
              canvasEl = getCanvasElement();
            }
            opts = Utils.getOptions(opts);
            const size = Utils.getImageWidth(qrData.modules.size, opts);
            const ctx = canvasEl.getContext("2d");
            const image = ctx.createImageData(size, size);
            Utils.qrToImageData(image.data, qrData, opts);
            clearCanvas(ctx, canvasEl, size);
            ctx.putImageData(image, 0, 0);
            return canvasEl;
          };
          exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
            let opts = options;
            if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
              opts = canvas;
              canvas = void 0;
            }
            if (!opts) opts = {};
            const canvasEl = exports.render(qrData, canvas, opts);
            const type = opts.type || "image/png";
            const rendererOpts = opts.rendererOpts || {};
            return canvasEl.toDataURL(type, rendererOpts.quality);
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/renderer/svg-tag.js
      var require_svg_tag = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/renderer/svg-tag.js"(exports) {
          var Utils = require_utils2();
          function getColorAttrib(color, attrib) {
            const alpha = color.a / 255;
            const str = attrib + '="' + color.hex + '"';
            return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
          }
          function svgCmd(cmd, x, y) {
            let str = cmd + x;
            if (typeof y !== "undefined") str += " " + y;
            return str;
          }
          function qrToPath(data, size, margin) {
            let path = "";
            let moveBy = 0;
            let newRow = false;
            let lineLength = 0;
            for (let i = 0; i < data.length; i++) {
              const col = Math.floor(i % size);
              const row = Math.floor(i / size);
              if (!col && !newRow) newRow = true;
              if (data[i]) {
                lineLength++;
                if (!(i > 0 && col > 0 && data[i - 1])) {
                  path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
                  moveBy = 0;
                  newRow = false;
                }
                if (!(col + 1 < size && data[i + 1])) {
                  path += svgCmd("h", lineLength);
                  lineLength = 0;
                }
              } else {
                moveBy++;
              }
            }
            return path;
          }
          exports.render = function render(qrData, options, cb) {
            const opts = Utils.getOptions(options);
            const size = qrData.modules.size;
            const data = qrData.modules.data;
            const qrcodesize = size + opts.margin * 2;
            const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
            const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
            const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
            const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
            const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
            if (typeof cb === "function") {
              cb(null, svgTag);
            }
            return svgTag;
          };
        }
      });
    
      // ../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/browser.js
      var require_browser = __commonJS({
        "../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/browser.js"(exports) {
          var canPromise = require_can_promise();
          var QRCode2 = require_qrcode();
          var CanvasRenderer = require_canvas();
          var SvgRenderer = require_svg_tag();
          function renderCanvas(renderFunc, canvas, text, opts, cb) {
            const args = [].slice.call(arguments, 1);
            const argsNum = args.length;
            const isLastArgCb = typeof args[argsNum - 1] === "function";
            if (!isLastArgCb && !canPromise()) {
              throw new Error("Callback required as last argument");
            }
            if (isLastArgCb) {
              if (argsNum < 2) {
                throw new Error("Too few arguments provided");
              }
              if (argsNum === 2) {
                cb = text;
                text = canvas;
                canvas = opts = void 0;
              } else if (argsNum === 3) {
                if (canvas.getContext && typeof cb === "undefined") {
                  cb = opts;
                  opts = void 0;
                } else {
                  cb = opts;
                  opts = text;
                  text = canvas;
                  canvas = void 0;
                }
              }
            } else {
              if (argsNum < 1) {
                throw new Error("Too few arguments provided");
              }
              if (argsNum === 1) {
                text = canvas;
                canvas = opts = void 0;
              } else if (argsNum === 2 && !canvas.getContext) {
                opts = text;
                text = canvas;
                canvas = void 0;
              }
              return new Promise(function(resolve, reject) {
                try {
                  const data = QRCode2.create(text, opts);
                  resolve(renderFunc(data, canvas, opts));
                } catch (e) {
                  reject(e);
                }
              });
            }
            try {
              const data = QRCode2.create(text, opts);
              cb(null, renderFunc(data, canvas, opts));
            } catch (e) {
              cb(e);
            }
          }
          exports.create = QRCode2.create;
          exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
          exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
          exports.toString = renderCanvas.bind(null, function(data, _, opts) {
            return SvgRenderer.render(data, opts);
          });
        }
      });
    
      // src/client/entry.ts
      var entry_exports = {};
      __export(entry_exports, {
        apply: () => apply,
        inject: () => inject
      });
    
      // src/client/index.tsx
      var import_react6 = __toESM(__require("react"), 1);
    
      // src/client/panels/SettingsPage.tsx
      var import_react5 = __toESM(__require("react"), 1);
    
      // src/client/components/ui.tsx
      var import_react = __toESM(__require("react"), 1);
      function Section(props) {
        return /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-section" }, props.title ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-section-head" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-section-title" }, props.title), props.hint ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-hint" }, props.hint) : null) : null, props.children);
      }
      function Row(props) {
        return /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-row" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-row-label" }, props.label), /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-row-body" }, props.children, props.hint ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-hint" }, props.hint) : null));
      }
      function Btn(props) {
        const className = [
          "tln-btn",
          props.variant === "primary" ? "tln-btn-primary" : "",
          props.variant === "danger" ? "tln-btn-danger" : "",
          props.size === "sm" ? "tln-btn-sm" : ""
        ].filter(Boolean).join(" ");
        return /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            className,
            onClick: props.onClick,
            disabled: props.disabled === true,
            title: props.title
          },
          props.children
        );
      }
      function Check(props) {
        const disabled = props.disabled === true;
        return /* @__PURE__ */ import_react.default.createElement("label", { className: disabled ? "tln-check tln-check-disabled" : "tln-check", title: props.title }, /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            type: "checkbox",
            checked: props.checked,
            disabled,
            onChange: (event) => props.onChange(event.target.checked)
          }
        ), /* @__PURE__ */ import_react.default.createElement("span", null, props.label));
      }
      function Seg(props) {
        return /* @__PURE__ */ import_react.default.createElement("div", { className: "tln-seg", role: "group", "aria-label": props.ariaLabel }, props.options.map((option) => /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            key: option.value,
            type: "button",
            "aria-pressed": option.value === props.value,
            title: option.title,
            disabled: props.disabled === true,
            onClick: () => {
              if (option.value !== props.value) props.onChange(option.value);
            }
          },
          option.label
        )));
      }
      function TextInput(props) {
        const [draft, setDraft] = import_react.default.useState(props.value);
        const [focused, setFocused] = import_react.default.useState(false);
        import_react.default.useEffect(() => {
          if (!focused) setDraft(props.value);
        }, [props.value, focused]);
        const commit = () => {
          if (draft !== props.value) props.onCommit(draft);
        };
        return /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            className: props.className ? `tln-input ${props.className}` : "tln-input",
            type: props.type ?? "text",
            value: draft,
            placeholder: props.placeholder,
            disabled: props.disabled === true,
            title: props.title,
            spellCheck: false,
            onFocus: () => setFocused(true),
            onBlur: () => {
              setFocused(false);
              commit();
            },
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setDraft(props.value);
                event.currentTarget.blur();
              }
            }
          }
        );
      }
      function TextArea(props) {
        const [draft, setDraft] = import_react.default.useState(props.value);
        const [focused, setFocused] = import_react.default.useState(false);
        import_react.default.useEffect(() => {
          if (!focused) setDraft(props.value);
        }, [props.value, focused]);
        return /* @__PURE__ */ import_react.default.createElement(
          "textarea",
          {
            className: "tln-textarea",
            value: draft,
            rows: props.rows ?? 3,
            placeholder: props.placeholder,
            disabled: props.disabled === true,
            spellCheck: false,
            onFocus: () => setFocused(true),
            onBlur: () => {
              setFocused(false);
              if (draft !== props.value) props.onCommit(draft);
            },
            onChange: (event) => setDraft(event.target.value)
          }
        );
      }
      function NumInput(props) {
        const [draft, setDraft] = import_react.default.useState(String(props.value));
        const [focused, setFocused] = import_react.default.useState(false);
        import_react.default.useEffect(() => {
          if (!focused) setDraft(String(props.value));
        }, [props.value, focused]);
        const commit = () => {
          const parsed = Number.parseInt(draft, 10);
          if (!Number.isFinite(parsed)) {
            setDraft(String(props.value));
            return;
          }
          const clamped = Math.min(props.max ?? Number.MAX_SAFE_INTEGER, Math.max(props.min ?? 0, parsed));
          setDraft(String(clamped));
          if (clamped !== props.value) props.onCommit(clamped);
        };
        return /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            className: "tln-input tln-input-num",
            type: "number",
            value: draft,
            min: props.min,
            max: props.max,
            disabled: props.disabled === true,
            title: props.title,
            onFocus: () => setFocused(true),
            onBlur: () => {
              setFocused(false);
              commit();
            },
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }
          }
        );
      }
      function Select(props) {
        return /* @__PURE__ */ import_react.default.createElement(
          "select",
          {
            className: "tln-select",
            value: props.value,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.value)
          },
          props.options.map((option) => /* @__PURE__ */ import_react.default.createElement("option", { key: option.value, value: option.value }, option.label))
        );
      }
      function Note(props) {
        const tone = props.tone ?? "info";
        const className = tone === "info" ? "tln-note" : `tln-note tln-note-${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "error"}`;
        return /* @__PURE__ */ import_react.default.createElement("div", { className }, props.children);
      }
      function Dot(props) {
        return /* @__PURE__ */ import_react.default.createElement("span", { className: `tln-dot tln-dot-${props.tone}` });
      }
    
      // src/client/panels/ChannelPanel.tsx
      var import_react4 = __toESM(__require("react"), 1);
    
      // src/client/components/SecretField.tsx
      var import_react2 = __toESM(__require("react"), 1);
      function SecretField(props) {
        const [editing, setEditing] = import_react2.default.useState(false);
        const [draft, setDraft] = import_react2.default.useState("");
        const disabled = props.disabled === true;
        const start = () => {
          setDraft("");
          setEditing(true);
        };
        const cancel = () => {
          setDraft("");
          setEditing(false);
        };
        const submit = () => {
          const value = draft.trim();
          if (value.length === 0) return;
          props.onCommit(value);
          setEditing(false);
          setDraft("");
        };
        return /* @__PURE__ */ import_react2.default.createElement("div", { className: "tln-row-body" }, /* @__PURE__ */ import_react2.default.createElement("div", { className: "tln-inline" }, /* @__PURE__ */ import_react2.default.createElement("span", { className: "tln-row-label", style: { paddingTop: 0 } }, props.label), editing ? /* @__PURE__ */ import_react2.default.createElement(import_react2.default.Fragment, null, /* @__PURE__ */ import_react2.default.createElement(
          "input",
          {
            className: "tln-input tln-grow",
            type: "password",
            value: draft,
            autoFocus: true,
            spellCheck: false,
            placeholder: props.label,
            disabled,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") submit();
              else if (event.key === "Escape") cancel();
            }
          }
        ), /* @__PURE__ */ import_react2.default.createElement(Btn, { variant: "primary", size: "sm", disabled: disabled || draft.trim().length === 0, onClick: submit }, props.t("save")), /* @__PURE__ */ import_react2.default.createElement(Btn, { size: "sm", disabled, onClick: cancel }, props.t("cancel"))) : /* @__PURE__ */ import_react2.default.createElement(import_react2.default.Fragment, null, /* @__PURE__ */ import_react2.default.createElement("span", { className: props.configured ? "tln-mono tln-grow" : "tln-hint tln-grow" }, props.configured ? props.hint || "\u2022\u2022\u2022\u2022" : props.t("notSet")), /* @__PURE__ */ import_react2.default.createElement(Btn, { size: "sm", disabled, onClick: start }, props.configured ? props.t("change") : props.t("fill")), props.configured ? /* @__PURE__ */ import_react2.default.createElement(Btn, { size: "sm", variant: "danger", disabled, onClick: () => props.onCommit("") }, props.t("secretClear")) : null)), /* @__PURE__ */ import_react2.default.createElement("div", { className: "tln-hint" }, props.t("secretHint")));
      }
    
      // src/client/components/QrCode.tsx
      var import_react3 = __toESM(__require("react"), 1);
    
      // src/client/qr.ts
      var import_qrcode = __toESM(require_browser(), 1);
      function buildQrMatrix(text) {
        const qr = import_qrcode.default.create(text, { errorCorrectionLevel: "M" });
        const size = qr.modules.size;
        const source = qr.modules.data;
        const bits = new Uint8Array(size * size);
        for (let index = 0; index < bits.length; index += 1) {
          bits[index] = source[index] ? 1 : 0;
        }
        return { size, bits };
      }
      function isDark(matrix, x, y) {
        if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return false;
        return matrix.bits[y * matrix.size + x] === 1;
      }
      function matrixToPath(matrix) {
        const parts = [];
        for (let y = 0; y < matrix.size; y += 1) {
          for (let x = 0; x < matrix.size; x += 1) {
            if (isDark(matrix, x, y)) parts.push(`M${x} ${y}h1v1h-1z`);
          }
        }
        return parts.join("");
      }
    
      // src/client/components/QrCode.tsx
      var QUIET_ZONE = 4;
      function QrCode(props) {
        const size = props.size ?? 208;
        const built = import_react3.default.useMemo(() => {
          try {
            const matrix = buildQrMatrix(props.text);
            return { matrix, path: matrixToPath(matrix) };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        }, [props.text]);
        if ("error" in built) {
          return /* @__PURE__ */ import_react3.default.createElement(Note, { tone: "error" }, "\u4E8C\u7EF4\u7801\u751F\u6210\u5931\u8D25\uFF1A", built.error);
        }
        const view = built.matrix.size + QUIET_ZONE * 2;
        return /* @__PURE__ */ import_react3.default.createElement("div", { className: "tln-qr-canvas" }, /* @__PURE__ */ import_react3.default.createElement(
          "svg",
          {
            viewBox: `0 0 ${view} ${view}`,
            width: size,
            height: size,
            role: "img",
            "aria-label": "QR",
            shapeRendering: "crispEdges"
          },
          /* @__PURE__ */ import_react3.default.createElement("rect", { x: 0, y: 0, width: view, height: view, fill: "#ffffff" }),
          /* @__PURE__ */ import_react3.default.createElement("path", { transform: `translate(${QUIET_ZONE} ${QUIET_ZONE})`, d: built.path, fill: "#000000" })
        ));
      }
    
      // src/client/draft.ts
      var FEISHU_RECEIVE_ID_TYPES = [
        "open_id",
        "chat_id",
        "user_id",
        "union_id",
        "email"
      ];
      function formatSessionFilter(list) {
        if (!list || list.length === 0) return "";
        return list.join("\n");
      }
      function parseSessionFilter(text) {
        return text.split(/[\n,，]/).map((item) => item.trim()).filter((item) => item.length > 0);
      }
      function toDraft(channel) {
        return {
          id: channel.id,
          type: channel.type,
          enabled: channel.enabled,
          label: channel.label ?? "",
          appId: channel.appId ?? "",
          targetChatId: channel.targetChatId ?? "",
          groupChatId: channel.groupChatId ?? "",
          feishuAppId: channel.feishuAppId ?? "",
          feishuReceiveId: channel.feishuReceiveId ?? "",
          feishuReceiveIdType: channel.feishuReceiveIdType,
          mode: channel.mode,
          sessionScope: channel.sessionScope,
          sessionFilter: formatSessionFilter(channel.sessionFilter),
          bindUrl: channel.bindUrl ?? "",
          overrideEvents: channel.overrideEvents,
          // 即使没开覆盖也照抄生效值：用户点开「自定义」的那一刻，看到的应该是
          // **当前正在生效的那份**，而不是内置默认——否则一开开关行为就变了。
          events: { ...channel.events },
          overrideContent: channel.overrideContent,
          content: { ...channel.content }
        };
      }
      function toDrafts(config) {
        return config.channels.map(toDraft);
      }
      function toPatch(draft) {
        return {
          id: draft.id,
          type: draft.type,
          enabled: draft.enabled,
          label: draft.label.trim(),
          appId: draft.appId.trim(),
          targetChatId: draft.targetChatId.trim(),
          groupChatId: draft.groupChatId.trim(),
          feishuAppId: draft.feishuAppId.trim(),
          feishuReceiveId: draft.feishuReceiveId.trim(),
          feishuReceiveIdType: draft.feishuReceiveIdType,
          mode: draft.mode,
          sessionScope: draft.sessionScope,
          sessionFilter: parseSessionFilter(draft.sessionFilter),
          bindUrl: draft.bindUrl.trim(),
          overrideEvents: draft.overrideEvents,
          events: draft.overrideEvents ? { ...draft.events } : null,
          overrideContent: draft.overrideContent,
          content: draft.overrideContent ? { ...draft.content } : null
        };
      }
      function toChannelPatches(drafts) {
        return drafts.map(toPatch);
      }
      function nextId(type, taken) {
        for (let index = 1; index < 1e3; index += 1) {
          const candidate = `${type}-${index}`;
          if (!taken.includes(candidate)) return candidate;
        }
        return `${type}-${Date.now()}`;
      }
      function createDraft(type, taken, global) {
        return {
          id: nextId(type, taken),
          type,
          // **默认不启用**：新通道还没有凭据，直接启用会让宿主立刻去建连并失败，
          // 在状态栏上留下一串「通道不可用」。等用户填完再自己打开。
          enabled: false,
          label: "",
          appId: "",
          targetChatId: "",
          groupChatId: "",
          feishuAppId: "",
          feishuReceiveId: "",
          feishuReceiveIdType: "open_id",
          mode: "active",
          // 新机器人默认**关心全局**（所有会话），这样「加一个机器人」不会是个哑巴；
          // 只想收特定会话的人可以到「更多设置 → 会话过滤」里改成列表。
          sessionScope: "all",
          sessionFilter: "",
          bindUrl: "",
          overrideEvents: false,
          events: { ...global.events },
          overrideContent: false,
          content: { ...global.content }
        };
      }
      function draftTitle(draft) {
        return draft.label.trim() || draft.id;
      }
    
      // src/client/panels/ChannelPanel.tsx
      var RAIL_TYPES = ["qq", "feishu"];
      function railLabel(t, type) {
        return type === "qq" ? t("railQq") : t("railFeishu");
      }
      function ChannelPanel(props) {
        const { t, drafts } = props;
        const [rail, setRail] = import_react4.default.useState("qq");
        const [openBotId, setOpenBotId] = import_react4.default.useState(null);
        const [subTab, setSubTab] = import_react4.default.useState("rules");
        const visible = drafts.filter((draft) => draft.type === rail);
        const viewOf = (id) => props.views.find((item) => item.id === id);
        const update = (id, patch) => {
          props.onChange(drafts.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
        };
        const openBot = drafts.find((draft) => draft.id === openBotId);
        return /* @__PURE__ */ import_react4.default.createElement(Section, { title: t("channels"), hint: t("channelsHint") }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-rail", role: "tablist", "aria-label": t("channels") }, RAIL_TYPES.map((type) => {
          const count = drafts.filter((draft) => draft.type === type).length;
          return /* @__PURE__ */ import_react4.default.createElement(
            "button",
            {
              key: type,
              type: "button",
              role: "tab",
              "aria-selected": rail === type,
              className: "tln-rail-tab",
              "data-active": rail === type ? "true" : "false",
              onClick: () => {
                setRail(type);
                setOpenBotId(null);
              }
            },
            /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-rail-name" }, railLabel(t, type)),
            /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-rail-count" }, t("botCount", { n: count }))
          );
        })), openBot ? /* @__PURE__ */ import_react4.default.createElement(
          BotSettingsPage,
          {
            t,
            draft: openBot,
            view: viewOf(openBot.id),
            busy: props.busy,
            secretEpoch: props.secretEpoch,
            isDefault: props.defaultChannelId === openBot.id,
            tab: subTab,
            onTab: setSubTab,
            onChange: (patch) => update(openBot.id, patch),
            onSecret: props.onSecret,
            onDefault: props.onDefault,
            onRemove: () => {
              if (typeof window !== "undefined" && !window.confirm(t("removeConfirm"))) return;
              props.onChange(drafts.filter((draft) => draft.id !== openBot.id));
              setOpenBotId(null);
            },
            onBack: () => setOpenBotId(null)
          }
        ) : /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-bots" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-panel-head" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-section-title" }, railLabel(t, rail)), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-spacer" }), rail === "qq" ? /* @__PURE__ */ import_react4.default.createElement(
          Btn,
          {
            variant: "primary",
            size: "sm",
            disabled: props.busy,
            onClick: () => props.onAdd("qq", true)
          },
          t("scanAdd")
        ) : null, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy, onClick: () => props.onAdd(rail, false) }, rail === "qq" ? t("manualAdd") : t("addFeishu"))), visible.length === 0 ? /* @__PURE__ */ import_react4.default.createElement(Note, { tone: "warn" }, t("botEmpty")) : null, visible.map((draft) => /* @__PURE__ */ import_react4.default.createElement(
          BotCard,
          {
            key: draft.id,
            t,
            draft,
            view: viewOf(draft.id),
            global: props.global,
            busy: props.busy,
            secretEpoch: props.secretEpoch,
            isDefault: props.defaultChannelId === draft.id,
            taken: drafts.map((item) => item.id),
            qr: props.qr && props.qr.channelId === draft.id ? props.qr : void 0,
            test: props.test && props.test.channelId === draft.id ? props.test : void 0,
            provision: props.provision && props.provision.channelId === draft.id ? props.provision : void 0,
            onChange: (patch) => update(draft.id, patch),
            onSecret: props.onSecret,
            onDefault: props.onDefault,
            onTest: props.onTest,
            onQr: props.onQr,
            onQrClose: props.onQrClose,
            onProvision: props.onProvision,
            onProvisionClose: props.onProvisionClose,
            onOpenSettings: (tab) => {
              setSubTab(tab);
              setOpenBotId(draft.id);
            },
            onRemove: () => {
              if (typeof window !== "undefined" && !window.confirm(t("removeConfirm"))) return;
              props.onChange(drafts.filter((item) => item.id !== draft.id));
            }
          }
        ))));
      }
      function BotCard(props) {
        const { t, draft } = props;
        const [open, setOpen] = import_react4.default.useState(false);
        const [wizard, setWizard] = import_react4.default.useState(false);
        const secretConfigured = draft.type === "qq" ? props.view?.appSecret.configured === true : props.view?.feishuAppSecret.configured === true;
        const target = draft.type === "qq" ? draft.targetChatId : draft.feishuReceiveId;
        const appId = draft.type === "qq" ? draft.appId : draft.feishuAppId;
        const tone = draft.enabled ? secretConfigured && target.trim().length > 0 ? "on" : "warn" : "off";
        return /* @__PURE__ */ import_react4.default.createElement("article", { className: "tln-botCard", "data-open": open ? "true" : "false", "data-bot-id": draft.id }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-botCard-head" }, /* @__PURE__ */ import_react4.default.createElement("button", { type: "button", className: "tln-botCard-toggle", onClick: () => setOpen(!open) }, /* @__PURE__ */ import_react4.default.createElement(Dot, { tone }), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-botCard-name" }, draftTitle(draft)), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-mono tln-botCard-id" }, draft.id), props.isDefault ? /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-note tln-note-ok" }, t("isDefault")) : null, /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-spacer" }), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-hint" }, target.trim().length === 0 ? t("summaryNoTarget") : appId.trim() || t("summaryOff")), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-caret" }, open ? "\u25BE" : "\u25B8"))), open ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-botCard-body" }, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("botName"), hint: t("botNameHint") }, /* @__PURE__ */ import_react4.default.createElement(
          TextInput,
          {
            value: draft.label,
            disabled: props.busy,
            placeholder: draft.id,
            onCommit: (value) => props.onChange({ label: value })
          }
        )), /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("channelEnabled") }, /* @__PURE__ */ import_react4.default.createElement(
          Check,
          {
            checked: draft.enabled,
            disabled: props.busy,
            label: draft.enabled ? t("on") : t("off"),
            onChange: (next) => props.onChange({ enabled: next })
          }
        )), /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("channelId"), hint: t("channelIdHint") }, /* @__PURE__ */ import_react4.default.createElement(
          TextInput,
          {
            value: draft.id,
            disabled: props.busy,
            onCommit: (value) => {
              const trimmed = value.trim();
              if (trimmed.length === 0 || props.taken.includes(trimmed)) return;
              props.onChange({ id: trimmed });
            }
          }
        )), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", variant: wizard ? "primary" : "default", disabled: props.busy, onClick: () => setWizard(!wizard) }, t("wizard")), /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy, onClick: () => props.onOpenSettings("rules") }, t("more")), /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy, onClick: () => props.onTest(draft.id) }, props.busy ? t("testing") : t("test")), /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy || props.isDefault, onClick: () => props.onDefault(draft.id) }, t("setDefault")), /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", variant: "danger", disabled: props.busy, onClick: props.onRemove }, t("remove"))), props.test ? /* @__PURE__ */ import_react4.default.createElement(Note, { tone: props.test.tone === "ok" ? "ok" : "error" }, props.test.text) : null, props.provision ? /* @__PURE__ */ import_react4.default.createElement(
          ProvisionBlock,
          {
            t,
            draft,
            state: props.provision,
            busy: props.busy,
            onRetry: () => props.onProvision(draft.id),
            onClose: props.onProvisionClose
          }
        ) : null, props.qr ? /* @__PURE__ */ import_react4.default.createElement(QrBlock, { t, qr: props.qr, onClose: props.onQrClose }) : null, wizard ? /* @__PURE__ */ import_react4.default.createElement(
          SetupWizard,
          {
            t,
            draft,
            view: props.view,
            appId,
            target,
            secretConfigured,
            busy: props.busy,
            secretEpoch: props.secretEpoch,
            test: props.test,
            onChange: props.onChange,
            onSecret: props.onSecret,
            onTest: props.onTest,
            onQr: props.onQr,
            onProvision: props.onProvision
          }
        ) : null) : null);
      }
      function SetupWizard(props) {
        const { t, draft } = props;
        const done = [
          props.appId.trim().length > 0,
          props.secretConfigured,
          props.target.trim().length > 0,
          props.test?.tone === "ok"
        ];
        const firstTodo = done.findIndex((item) => !item);
        const [openStep, setOpenStep] = import_react4.default.useState(firstTodo === -1 ? 1 : firstTodo + 1);
        const toggle = (step) => {
          setOpenStep(openStep === step ? 0 : step);
        };
        const stepHead = (step, title) => /* @__PURE__ */ import_react4.default.createElement(
          "button",
          {
            type: "button",
            className: "tln-step-head",
            "data-open": openStep === step ? "true" : "false",
            onClick: () => toggle(step)
          },
          /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-step-index" }, t("stepLabel", { n: step })),
          /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-step-title" }, title),
          /* @__PURE__ */ import_react4.default.createElement("span", { className: done[step - 1] ? "tln-note tln-note-ok" : "tln-hint" }, done[step - 1] ? t("stepDone") : t("stepTodo")),
          /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-spacer" }),
          /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-caret" }, openStep === step ? "\u25BE" : "\u25B8")
        );
        const body = (step, children) => openStep === step ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-step-body" }, children, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", onClick: () => setOpenStep(step === 4 ? 0 : step + 1) }, t("stepSkip")))) : null;
        return /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-wizard" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-section-head" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-section-title" }, t("wizard")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("wizardHint"))), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-step" }, stepHead(1, t("step1")), body(
          1,
          draft.type === "qq" ? /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement("p", { className: "tln-hint" }, t("step1Qq")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", variant: "primary", disabled: props.busy, onClick: () => props.onProvision(draft.id) }, t("scanAdd")), /* @__PURE__ */ import_react4.default.createElement("a", { className: "tln-link", href: "https://q.qq.com/qqbot/openclaw", target: "_blank", rel: "noreferrer" }, t("openQqPlatform")))) : /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement("p", { className: "tln-hint" }, t("step1Feishu")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement("a", { className: "tln-link", href: "https://open.feishu.cn/app", target: "_blank", rel: "noreferrer" }, t("openFeishuPlatform"))))
        )), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-step" }, stepHead(2, t("step2")), body(
          2,
          /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("appId"), hint: t("step2Hint") }, /* @__PURE__ */ import_react4.default.createElement(
            TextInput,
            {
              value: props.appId,
              disabled: props.busy,
              placeholder: draft.type === "qq" ? "102xxxxxx" : "cli_xxxxxxxxxxxx",
              onCommit: (value) => props.onChange(draft.type === "qq" ? { appId: value } : { feishuAppId: value })
            }
          )), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-row" }, /* @__PURE__ */ import_react4.default.createElement(
            SecretField,
            {
              key: `${draft.id}:${draft.type}:${props.secretEpoch}`,
              label: t("appSecret"),
              configured: props.secretConfigured,
              hint: draft.type === "qq" ? props.view?.appSecret.hint ?? "" : props.view?.feishuAppSecret.hint ?? "",
              disabled: props.busy,
              t,
              onCommit: (value) => props.onSecret(draft.id, draft.type === "qq" ? "appSecret" : "feishuAppSecret", value)
            }
          )), draft.type === "feishu" ? /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("receiveIdType") }, /* @__PURE__ */ import_react4.default.createElement(
            Select,
            {
              value: draft.feishuReceiveIdType,
              disabled: props.busy,
              options: FEISHU_RECEIVE_ID_TYPES.map((item) => ({ value: item, label: item })),
              onChange: (value) => props.onChange({ feishuReceiveIdType: value })
            }
          )) : null)
        )), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-step" }, stepHead(3, t("step3")), body(
          3,
          /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement("p", { className: "tln-hint" }, draft.type === "qq" ? t("step3Qq") : t("step3Feishu")), /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("targetId") }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-inline" }, /* @__PURE__ */ import_react4.default.createElement(
            TextInput,
            {
              className: "tln-grow",
              value: props.target,
              disabled: props.busy,
              onCommit: (value) => props.onChange(draft.type === "qq" ? { targetChatId: value } : { feishuReceiveId: value })
            }
          ), /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy, onClick: () => props.onQr(draft.id) }, t("qrBind")))))
        )), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-step" }, stepHead(4, t("step4")), body(
          4,
          /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy, onClick: () => props.onTest(draft.id) }, props.busy ? t("testing") : t("test")), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-hint" }, t("testHint")))
        )));
      }
      function BotSettingsPage(props) {
        const { t, draft } = props;
        const tabs = [
          { value: "rules", label: t("tabRules") },
          { value: "sessions", label: t("tabSessions") },
          { value: "advanced", label: t("tabAdvanced") }
        ];
        return /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-subpage" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-subpage-head" }, /* @__PURE__ */ import_react4.default.createElement("button", { type: "button", className: "tln-link", onClick: props.onBack }, t("backToList")), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-spacer" }), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-botCard-name" }, draftTitle(draft)), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-mono tln-botCard-id" }, draft.id)), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-tabs", role: "tablist" }, tabs.map((item) => /* @__PURE__ */ import_react4.default.createElement(
          "button",
          {
            key: item.value,
            type: "button",
            role: "tab",
            "aria-selected": props.tab === item.value,
            className: "tln-tab",
            "data-active": props.tab === item.value ? "true" : "false",
            onClick: () => props.onTab(item.value)
          },
          item.label
        ))), props.tab === "rules" ? /* @__PURE__ */ import_react4.default.createElement(RulesTab, { ...props }) : null, props.tab === "sessions" ? /* @__PURE__ */ import_react4.default.createElement(SessionsTab, { ...props }) : null, props.tab === "advanced" ? /* @__PURE__ */ import_react4.default.createElement(AdvancedTab, { ...props }) : null);
      }
      function RulesTab(props) {
        const { t, draft } = props;
        return /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("events"), hint: draft.overrideEvents ? t("customHint") : t("followGlobalHint") }, /* @__PURE__ */ import_react4.default.createElement(
          Seg,
          {
            value: draft.overrideEvents ? "custom" : "global",
            disabled: props.busy,
            ariaLabel: t("events"),
            options: [
              { value: "global", label: t("followGlobal") },
              { value: "custom", label: t("custom") }
            ],
            onChange: (value) => props.onChange({ overrideEvents: value === "custom" })
          }
        )), draft.overrideEvents ? /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, [
          ["onTurnEnd", t("evTurnEnd")],
          ["onError", t("evError")],
          ["onAborted", t("evAborted")],
          ["onPending", t("evPending")],
          ["onMaxTokens", t("evMaxTokens")],
          ["includeSubagent", t("evIncludeSubagent")]
        ].map(([key, label]) => /* @__PURE__ */ import_react4.default.createElement(Row, { key, label }, /* @__PURE__ */ import_react4.default.createElement(
          Check,
          {
            checked: draft.events[key],
            disabled: props.busy,
            label: draft.events[key] ? t("on") : t("off"),
            onChange: (next) => props.onChange({ events: { ...draft.events, [key]: next } })
          }
        )))) : null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("content"), hint: draft.overrideContent ? t("customHint") : t("followGlobalHint") }, /* @__PURE__ */ import_react4.default.createElement(
          Seg,
          {
            value: draft.overrideContent ? "custom" : "global",
            disabled: props.busy,
            ariaLabel: t("content"),
            options: [
              { value: "global", label: t("followGlobal") },
              { value: "custom", label: t("custom") }
            ],
            onChange: (value) => props.onChange({ overrideContent: value === "custom" })
          }
        )), draft.overrideContent ? /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("ctIncludeMetadata") }, /* @__PURE__ */ import_react4.default.createElement(
          Check,
          {
            checked: draft.content.includeMetadata,
            disabled: props.busy,
            label: draft.content.includeMetadata ? t("on") : t("off"),
            onChange: (next) => props.onChange({ content: { ...draft.content, includeMetadata: next } })
          }
        )), /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("ctIncludeUserPrompt") }, /* @__PURE__ */ import_react4.default.createElement(
          Check,
          {
            checked: draft.content.includeUserPrompt,
            disabled: props.busy,
            label: draft.content.includeUserPrompt ? t("on") : t("off"),
            onChange: (next) => props.onChange({ content: { ...draft.content, includeUserPrompt: next } })
          }
        )), /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("ctMaxBodyChars"), hint: t("ctMaxBodyCharsHint") }, /* @__PURE__ */ import_react4.default.createElement(
          NumInput,
          {
            value: draft.content.maxBodyChars,
            min: 200,
            max: 2e4,
            disabled: props.busy,
            onCommit: (value) => props.onChange({ content: { ...draft.content, maxBodyChars: value } })
          }
        ))) : null);
      }
      function SessionsTab(props) {
        const { t, draft } = props;
        return /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("tabSessions"), hint: t("scopeHint") }, /* @__PURE__ */ import_react4.default.createElement(
          Seg,
          {
            value: draft.sessionScope,
            disabled: props.busy,
            ariaLabel: t("tabSessions"),
            options: [
              { value: "all", label: t("scopeAll") },
              { value: "filter", label: t("scopeFilter") }
            ],
            onChange: (value) => props.onChange({ sessionScope: value })
          }
        )), draft.sessionScope === "filter" ? /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("sessionFilter"), hint: t("sessionFilterHint") }, /* @__PURE__ */ import_react4.default.createElement(
          TextArea,
          {
            value: draft.sessionFilter,
            disabled: props.busy,
            rows: 4,
            onCommit: (value) => props.onChange({ sessionFilter: value })
          }
        )) : null);
      }
      function AdvancedTab(props) {
        const { t, draft } = props;
        return /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("pushMode"), hint: t("pushModeHint") }, /* @__PURE__ */ import_react4.default.createElement(
          Seg,
          {
            value: draft.mode,
            disabled: props.busy,
            ariaLabel: t("pushMode"),
            options: [
              { value: "active", label: t("pushActive") },
              { value: "passive", label: t("pushPassive") }
            ],
            onChange: (value) => props.onChange({ mode: value })
          }
        )), /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("bindLink"), hint: t("bindLinkHint") }, /* @__PURE__ */ import_react4.default.createElement(
          TextInput,
          {
            value: draft.bindUrl,
            disabled: props.busy,
            placeholder: "https://\u2026",
            onCommit: (value) => props.onChange({ bindUrl: value })
          }
        )), draft.type === "feishu" ? /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("receiveIdType") }, /* @__PURE__ */ import_react4.default.createElement(
          Select,
          {
            value: draft.feishuReceiveIdType,
            disabled: props.busy,
            options: FEISHU_RECEIVE_ID_TYPES.map((item) => ({ value: item, label: item })),
            onChange: (value) => props.onChange({ feishuReceiveIdType: value })
          }
        )) : null, /* @__PURE__ */ import_react4.default.createElement(Row, { label: t("groupChatId"), hint: t("groupChatIdHint") }, /* @__PURE__ */ import_react4.default.createElement(
          TextInput,
          {
            value: draft.groupChatId,
            disabled: props.busy,
            onCommit: (value) => props.onChange({ groupChatId: value })
          }
        )), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", disabled: props.busy || props.isDefault, onClick: () => props.onDefault(draft.id) }, t("setDefault")), /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", variant: "danger", disabled: props.busy, onClick: props.onRemove }, t("remove"))));
      }
      function ProvisionBlock(props) {
        const { t, state } = props;
        const snapshot = state.snapshot;
        const phase = snapshot?.state ?? "starting";
        const footer = (retry) => /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, retry ? /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", variant: "primary", disabled: props.busy, onClick: props.onRetry }, t("provisionRetry")) : null, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", onClick: props.onClose }, t("qrClose")));
        if (!snapshot) {
          return /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-card" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-card-head" }, t("provisionTitle")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, state.message ?? t("provisionStarting")), footer(false));
        }
        if (phase === "done") {
          return /* @__PURE__ */ import_react4.default.createElement(Note, { tone: "ok" }, t("provisionDone"), footer(false));
        }
        if (phase === "failed" || phase === "expired" || phase === "cancelled") {
          const text = phase === "failed" ? `${t("provisionFailed")}\uFF1A${snapshot.error ?? state.message ?? ""}` : phase === "expired" ? t("provisionExpired") : t("provisionCancelled");
          return /* @__PURE__ */ import_react4.default.createElement(Note, { tone: phase === "failed" ? "error" : "warn" }, text, footer(phase !== "cancelled"));
        }
        const qrText = snapshot.qrText;
        return /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-card" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-card-head" }, t("provisionTitle"), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-spacer" }), snapshot.expiresAt ? /* @__PURE__ */ import_react4.default.createElement(Countdown, { t, until: snapshot.expiresAt }) : null), phase === "connecting" ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("provisionConnecting")) : phase === "scanned" ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("provisionScanned")) : qrText ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-qr-layout" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-qr-img" }, /* @__PURE__ */ import_react4.default.createElement(QrCode, { text: qrText })), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-qr-side" }, /* @__PURE__ */ import_react4.default.createElement("p", { className: "tln-hint" }, t("provisionHint")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, props.draft.type === "qq" ? "" : t("provisionFeishu")))) : /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("provisionStarting")), footer(true));
      }
      function Countdown(props) {
        const [left, setLeft] = import_react4.default.useState(Math.max(0, props.until - Date.now()));
        import_react4.default.useEffect(() => {
          const timer = window.setInterval(() => setLeft(Math.max(0, props.until - Date.now())), 1e3);
          return () => window.clearInterval(timer);
        }, [props.until]);
        const seconds = Math.ceil(left / 1e3);
        const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
        const ss = String(seconds % 60).padStart(2, "0");
        return /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-mono" }, `${mm}:${ss}`);
      }
      function QrBlock(props) {
        const { t, qr } = props;
        if (qr.phase === "failed") {
          return /* @__PURE__ */ import_react4.default.createElement(Note, { tone: "error" }, qr.message ?? t("loadFailed"), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", onClick: props.onClose }, t("qrClose"))));
        }
        if (qr.phase === "expired") {
          return /* @__PURE__ */ import_react4.default.createElement(Note, { tone: "warn" }, t("qrExpired"), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", onClick: props.onClose }, t("qrClose"))));
        }
        if (qr.phase === "done") {
          return /* @__PURE__ */ import_react4.default.createElement(Note, { tone: "ok" }, t("qrDone"), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", onClick: props.onClose }, t("qrClose"))));
        }
        const text = qr.payload?.qrText;
        return /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-card" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-card-head" }, t("qrTitle")), qr.phase === "loading" || !text ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("qrWorking")) : /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-qr-layout" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-qr-img" }, /* @__PURE__ */ import_react4.default.createElement(QrCode, { text })), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-qr-side" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("qrWaiting")), qr.payload && qr.payload.derived === false ? /* @__PURE__ */ import_react4.default.createElement("div", null, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-hint" }, t("qrFallback")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-mono", style: { wordBreak: "break-all" } }, text)) : null, /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-kv" }, /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-hint" }, t("qrBind")), /* @__PURE__ */ import_react4.default.createElement("span", { className: "tln-mono" }, qr.payload?.token)))), /* @__PURE__ */ import_react4.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react4.default.createElement(Btn, { size: "sm", onClick: props.onClose }, t("qrClose"))));
      }
    
      // src/protocol.ts
      var RPC_API_CHANNEL = "/api";
      var RPC_ENDPOINT_PREFIX = "tlnotify";
      var RPC_ROUTE_PREFIX = `${RPC_API_CHANNEL}/${RPC_ENDPOINT_PREFIX}`;
      var RPC_METHODS = Object.freeze([
        "state",
        "patch",
        "test",
        "qr",
        "bind",
        "provision.begin",
        "provision.poll",
        "provision.cancel"
      ]);
      function rpcEndpoint(method) {
        return `${RPC_ENDPOINT_PREFIX}/${method}`;
      }
      var BIND_TTL_MS = 10 * 60 * 1e3;
    
      // src/client/rpc.ts
      var NO_CONNECTION = {
        ok: false,
        error: {
          code: "no-connection",
          message: "\u6D4F\u89C8\u5668\u6CA1\u6709\u8FDE\u4E0A\u5BBF\u4E3B\uFF0C\u8FD9\u4E00\u9875\u73B0\u5728\u53EA\u80FD\u770B\uFF0C\u4E0D\u80FD\u6539\u3002",
          details: {}
        }
      };
      function createClientRpc(ctx) {
        const read = () => {
          try {
            const queried = typeof ctx.get === "function" ? ctx.get("connection") : void 0;
            const service = queried ?? ctx.connection;
            const rpc = service?.rpc;
            return typeof rpc?.call === "function" ? rpc : void 0;
          } catch {
            return void 0;
          }
        };
        return {
          get available() {
            return typeof read()?.call === "function";
          },
          async call(method, payload = {}) {
            const rpc = read();
            if (!rpc || typeof rpc.call !== "function") return NO_CONNECTION;
            let raw;
            try {
              raw = await rpc.call(RPC_API_CHANNEL, rpcEndpoint(method), payload);
            } catch (error) {
              const failure = error;
              return {
                ok: false,
                error: {
                  code: typeof failure?.code === "string" ? failure.code : "transport",
                  message: typeof failure?.message === "string" && failure.message.length > 0 ? failure.message : "\u548C\u5BBF\u4E3B\u7684\u8FDE\u63A5\u65AD\u5F00\u4E86\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\u3002",
                  details: isRecord(failure?.details) ? failure.details : {}
                }
              };
            }
            if (!isRecord(raw) || typeof raw.ok !== "boolean") {
              return {
                ok: false,
                error: { code: "bad-response", message: "\u5BBF\u4E3B\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u54CD\u5E94\u3002", details: {} }
              };
            }
            if (raw.ok === false) {
              const error = isRecord(raw.error) ? raw.error : {};
              return {
                ok: false,
                error: {
                  code: typeof error.code === "string" ? error.code : "unknown",
                  message: typeof error.message === "string" ? error.message : "\u5BBF\u4E3B\u6CA1\u6709\u8BF4\u660E\u5931\u8D25\u539F\u56E0\u3002",
                  details: isRecord(error.details) ? error.details : {}
                }
              };
            }
            return { ok: true, value: raw.value };
          }
        };
      }
      function isRecord(value) {
        return typeof value === "object" && value !== null;
      }
    
      // src/client/panels/SettingsPage.tsx
      function sameChannelIds(drafts, views) {
        if (drafts.length !== views.length) return false;
        for (let index = 0; index < drafts.length; index += 1) {
          if (drafts[index].id !== views[index].id) return false;
        }
        return true;
      }
      function formatTime(stamp) {
        try {
          return new Date(stamp).toLocaleTimeString();
        } catch {
          return String(stamp);
        }
      }
      function SettingsPage(props) {
        const { t } = props;
        const rpc = import_react5.default.useMemo(() => createClientRpc(props.ctx), [props.ctx]);
        const [state, setState] = import_react5.default.useState(void 0);
        const [drafts, setDrafts] = import_react5.default.useState([]);
        const [busy, setBusy] = import_react5.default.useState(false);
        const [error, setError] = import_react5.default.useState(void 0);
        const [flash, setFlash] = import_react5.default.useState(void 0);
        const [qr, setQr] = import_react5.default.useState(void 0);
        const [test, setTest] = import_react5.default.useState(void 0);
        const [provision, setProvision] = import_react5.default.useState(void 0);
        const [secretEpoch, setSecretEpoch] = import_react5.default.useState(0);
        const applyState = import_react5.default.useCallback((next, force = false) => {
          setState(next);
          setDrafts(
            (previous) => !force && sameChannelIds(previous, next.config.channels) ? previous : toDrafts(next.config)
          );
        }, []);
        const reload = import_react5.default.useCallback(
          async (force = false) => {
            try {
              const result = await rpc.call("state");
              if (!result.ok) {
                setError(result.error.message);
                return;
              }
              setError(void 0);
              applyState(result.value, force);
            } catch (error2) {
              setError(error2 instanceof Error ? error2.message : String(error2));
            }
          },
          [rpc, applyState]
        );
        import_react5.default.useEffect(() => {
          void reload();
        }, [reload]);
        import_react5.default.useEffect(() => {
          if (!flash) return;
          const timer = window.setTimeout(() => setFlash(void 0), 2200);
          return () => window.clearTimeout(timer);
        }, [flash]);
        const patch = import_react5.default.useCallback(
          async (next, bumpSecret = false) => {
            setBusy(true);
            setError(void 0);
            try {
              const result = await rpc.call("patch", { patch: next });
              if (!result.ok) {
                setError(result.error.message);
                return false;
              }
              setState((previous) => previous ? { ...previous, config: result.value.config } : previous);
              setFlash(t("saved"));
              if (bumpSecret) setSecretEpoch((value) => value + 1);
              const fresh = await rpc.call("state");
              if (fresh.ok) setState((previous) => previous ? { ...previous, status: fresh.value.status } : previous);
              return true;
            } finally {
              setBusy(false);
            }
          },
          [rpc, t]
        );
        const commitChannels = import_react5.default.useCallback(
          (next, bumpSecret = false) => {
            setDrafts(next.slice());
            void patch({ channels: toChannelPatches(next) }, bumpSecret);
          },
          [patch]
        );
        const beginProvision = import_react5.default.useCallback(
          async (channelId) => {
            setProvision({ channelId });
            const result = await rpc.call("provision.begin", { channelId });
            if (!result.ok) {
              setProvision({ channelId, message: result.error.message });
              return;
            }
            setProvision({ channelId, snapshot: result.value });
          },
          [rpc]
        );
        const closeProvision = import_react5.default.useCallback(() => {
          const current = provision;
          setProvision(void 0);
          const snapshot = current?.snapshot;
          if (!current || !snapshot) return;
          if (snapshot.state === "done" || snapshot.state === "failed" || snapshot.state === "cancelled") return;
          void rpc.call("provision.cancel", {
            channelId: current.channelId,
            attemptId: snapshot.attemptId
          });
        }, [provision, rpc]);
        const addChannel = import_react5.default.useCallback(
          (type, startProvision = false) => {
            if (!state) return;
            const draft = createDraft(type, drafts.map((item) => item.id), {
              events: state.config.events,
              content: state.config.content
            });
            const next = [...drafts, draft];
            setDrafts(next);
            void (async () => {
              const saved = await patch({ channels: toChannelPatches(next) });
              if (saved && startProvision) void beginProvision(draft.id);
            })();
          },
          [state, drafts, patch, beginProvision]
        );
        const provisionChannelId = provision?.channelId;
        const provisionAttemptId = provision?.snapshot?.attemptId;
        const provisionState = provision?.snapshot?.state;
        const provisionInterval = provision?.snapshot?.pollIntervalMs;
        import_react5.default.useEffect(() => {
          if (!provisionChannelId || !provisionAttemptId) return void 0;
          if (provisionState !== "starting" && provisionState !== "waiting" && provisionState !== "scanned" && provisionState !== "connecting") {
            return void 0;
          }
          let cancelled = false;
          const tick = async () => {
            const result = await rpc.call("provision.poll", {
              channelId: provisionChannelId,
              attemptId: provisionAttemptId
            });
            if (cancelled) return;
            if (!result.ok) {
              setProvision({ channelId: provisionChannelId, message: result.error.message });
              return;
            }
            setProvision({ channelId: provisionChannelId, snapshot: result.value });
            if (result.value.state === "done") await reload(true);
          };
          const timer = window.setInterval(() => {
            void tick();
          }, Math.max(500, provisionInterval ?? 1e3));
          return () => {
            cancelled = true;
            window.clearInterval(timer);
          };
        }, [provisionChannelId, provisionAttemptId, provisionState, provisionInterval, rpc, reload]);
        const saveSecret = import_react5.default.useCallback(
          (id, field, value) => {
            const next = drafts.map((draft) => {
              const base = toChannelPatches([draft])[0];
              if (draft.id !== id) return base;
              return field === "appSecret" ? { ...base, appSecret: value } : { ...base, feishuAppSecret: value };
            });
            void patch({ channels: next }, true);
          },
          [drafts, patch]
        );
        const runTest = import_react5.default.useCallback(
          async (channelId) => {
            setBusy(true);
            setTest(void 0);
            try {
              const result = await rpc.call("test", { channelId });
              if (!result.ok) {
                setTest({ channelId, tone: "error", text: result.error.message });
                return;
              }
              setTest({ channelId, tone: "ok", text: `${t("testOk")} \u2014 ${result.value.summary}` });
            } finally {
              setBusy(false);
            }
          },
          [rpc, t]
        );
        const openQr = import_react5.default.useCallback(
          async (channelId) => {
            setQr({ channelId, phase: "loading" });
            const result = await rpc.call("qr", { channelId });
            if (!result.ok) {
              setQr({ channelId, phase: "failed", message: result.error.message });
              return;
            }
            setQr({ channelId, phase: "waiting", payload: result.value });
          },
          [rpc]
        );
        const qrChannelId = qr?.channelId;
        const qrToken = qr?.payload?.token;
        const qrPhase = qr?.phase;
        import_react5.default.useEffect(() => {
          if (qrPhase !== "waiting" || !qrChannelId || !qrToken) return void 0;
          let cancelled = false;
          const tick = async () => {
            const result = await rpc.call("bind", { channelId: qrChannelId, token: qrToken });
            if (cancelled) return;
            if (!result.ok) {
              setQr({ channelId: qrChannelId, phase: "failed", message: result.error.message });
              return;
            }
            if (result.value.expired) {
              setQr({ channelId: qrChannelId, phase: "expired" });
              return;
            }
            if (result.value.bound) {
              setQr({ channelId: qrChannelId, phase: "done" });
              await reload();
            }
          };
          const timer = window.setInterval(() => {
            void tick();
          }, 2e3);
          void tick();
          return () => {
            cancelled = true;
            window.clearInterval(timer);
          };
        }, [qrPhase, qrChannelId, qrToken, rpc, reload]);
        if (!state) {
          return /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-page" }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-head" }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-title" }, t("title")), /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-subtitle" }, t("subtitle"))), error ? /* @__PURE__ */ import_react5.default.createElement(Note, { tone: "error" }, t("loadFailed"), "\uFF1A", error, /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-actions" }, /* @__PURE__ */ import_react5.default.createElement(Btn, { size: "sm", onClick: () => void reload() }, t("retry")))) : /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-busy" }, t("loading")));
        }
        const config = state.config;
        const status = state.status;
        const disabled = busy || !rpc.available;
        const upChannels = status.channels.filter((channel) => channel.connected).length;
        const anyUp = upChannels > 0;
        const statusText = !status.running ? status.enabled ? t("statusIdle") : t("statusDisabled") : t("statusRunning");
        return /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-page" }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-head" }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-title" }, t("title")), /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-subtitle" }, t("subtitle")), /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-statusbar" }, /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-status-item" }, /* @__PURE__ */ import_react5.default.createElement(Dot, { tone: status.running ? anyUp ? "on" : "warn" : "off" }), statusText), /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-status-item" }, t("statusPushed", { n: status.pushed })), /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-status-item" }, t("statusChannels", { ok: upChannels, total: config.channels.length })), /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-status-item" }, t("statusSince", { time: formatTime(status.startedAt) })), /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-spacer" }), flash ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-status-item tln-note-ok" }, flash) : null, /* @__PURE__ */ import_react5.default.createElement(Btn, { size: "sm", disabled: busy, onClick: () => void reload() }, t("reload")))), !rpc.available ? /* @__PURE__ */ import_react5.default.createElement(Note, { tone: "warn" }, t("noConnection")) : null, error ? /* @__PURE__ */ import_react5.default.createElement(Note, { tone: "error" }, error) : null, /* @__PURE__ */ import_react5.default.createElement(Section, { title: t("status"), hint: t("unsavedHint") }, /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("enabledLabel"), hint: t("enabledHint") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.enabled,
            disabled,
            label: config.enabled ? t("on") : t("off"),
            onChange: (value) => void patch({ enabled: value })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("defaultChannel"), hint: t("defaultChannelNone") }, /* @__PURE__ */ import_react5.default.createElement(
          Select,
          {
            value: config.defaultChannelId ?? "",
            disabled,
            options: [
              { value: "", label: t("defaultChannelNone") },
              ...config.channels.map((channel) => ({ value: channel.id, label: channel.id }))
            ],
            onChange: (value) => void patch({ defaultChannelId: value.length === 0 ? null : value })
          }
        ))), /* @__PURE__ */ import_react5.default.createElement(Section, { title: t("runMode"), hint: config.mode === "global" ? t("modeGlobalHint") : t("modeSessionHint") }, /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("runMode") }, /* @__PURE__ */ import_react5.default.createElement(
          Seg,
          {
            value: config.mode,
            disabled,
            ariaLabel: t("runMode"),
            options: [
              { value: "global", label: t("modeGlobal") },
              { value: "session", label: t("modeSession") }
            ],
            onChange: (value) => void patch({ mode: value })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("boundSession"), hint: config.mode === "session" ? void 0 : t("modeGlobalHint") }, config.session.targetSessionId ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-mono" }, config.session.targetSessionId) : /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-hint" }, t("noBoundSession"))), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("detailSessions") }, /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-mono" }, status.detailSessions.length === 0 ? t("detailNone") : status.detailSessions.join(", ")))), /* @__PURE__ */ import_react5.default.createElement(
          ChannelPanel,
          {
            t,
            drafts,
            views: config.channels,
            global: { events: config.events, content: config.content },
            defaultChannelId: config.defaultChannelId,
            busy,
            secretEpoch,
            qr,
            test,
            provision,
            onChange: (next) => commitChannels(next),
            onAdd: addChannel,
            onSecret: saveSecret,
            onDefault: (id) => void patch({ defaultChannelId: id }),
            onTest: (id) => void runTest(id),
            onQr: (id) => void openQr(id),
            onQrClose: () => setQr(void 0),
            onProvision: (id) => void beginProvision(id),
            onProvisionClose: closeProvision
          }
        ), /* @__PURE__ */ import_react5.default.createElement(Section, { title: t("events"), hint: t("eventsHint") }, /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("evTurnEnd") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.events.onTurnEnd,
            disabled,
            label: config.events.onTurnEnd ? t("on") : t("off"),
            onChange: (value) => void patch({ events: { ...config.events, onTurnEnd: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("evError") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.events.onError,
            disabled,
            label: config.events.onError ? t("on") : t("off"),
            onChange: (value) => void patch({ events: { ...config.events, onError: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("evAborted") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.events.onAborted,
            disabled,
            label: config.events.onAborted ? t("on") : t("off"),
            onChange: (value) => void patch({ events: { ...config.events, onAborted: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("evPending") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.events.onPending,
            disabled,
            label: config.events.onPending ? t("on") : t("off"),
            onChange: (value) => void patch({ events: { ...config.events, onPending: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("evMaxTokens") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.events.onMaxTokens,
            disabled,
            label: config.events.onMaxTokens ? t("on") : t("off"),
            onChange: (value) => void patch({ events: { ...config.events, onMaxTokens: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("evIncludeSubagent"), hint: t("evIncludeSubagentHint") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.events.includeSubagent,
            disabled,
            label: config.events.includeSubagent ? t("on") : t("off"),
            onChange: (value) => void patch({ events: { ...config.events, includeSubagent: value } })
          }
        ))), /* @__PURE__ */ import_react5.default.createElement(Section, { title: t("content"), hint: t("contentHint") }, /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("ctIncludeMetadata") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.content.includeMetadata,
            disabled,
            label: config.content.includeMetadata ? t("on") : t("off"),
            onChange: (value) => void patch({ content: { ...config.content, includeMetadata: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("ctIncludeUserPrompt") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.content.includeUserPrompt,
            disabled,
            label: config.content.includeUserPrompt ? t("on") : t("off"),
            onChange: (value) => void patch({ content: { ...config.content, includeUserPrompt: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("ctMaxBodyChars"), hint: t("ctMaxBodyCharsHint") }, /* @__PURE__ */ import_react5.default.createElement(
          NumInput,
          {
            value: config.content.maxBodyChars,
            min: 200,
            max: 2e4,
            disabled,
            onCommit: (value) => void patch({ content: { ...config.content, maxBodyChars: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-section-head" }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "tln-section-title" }, t("sessionContext"))), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("scIncludeAssistant") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.session.context.includeAssistant,
            disabled,
            label: config.session.context.includeAssistant ? t("on") : t("off"),
            onChange: (value) => void patch({ session: { ...config.session, context: { ...config.session.context, includeAssistant: value } } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("scIncludeTools") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.session.context.includeTools,
            disabled,
            label: config.session.context.includeTools ? t("on") : t("off"),
            onChange: (value) => void patch({ session: { ...config.session, context: { ...config.session.context, includeTools: value } } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("scIncludeTiming") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.session.context.includeTiming,
            disabled,
            label: config.session.context.includeTiming ? t("on") : t("off"),
            onChange: (value) => void patch({ session: { ...config.session, context: { ...config.session.context, includeTiming: value } } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("scIncludeUserPrompt") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.session.context.includeUserPrompt,
            disabled,
            label: config.session.context.includeUserPrompt ? t("on") : t("off"),
            onChange: (value) => void patch({
              session: { ...config.session, context: { ...config.session.context, includeUserPrompt: value } }
            })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("scPreviousTurns") }, /* @__PURE__ */ import_react5.default.createElement(
          NumInput,
          {
            value: config.session.context.previousTurns,
            min: 0,
            max: 20,
            disabled,
            onCommit: (value) => void patch({ session: { ...config.session, context: { ...config.session.context, previousTurns: value } } })
          }
        ))), /* @__PURE__ */ import_react5.default.createElement(Section, { title: t("routing"), hint: t("routingHint") }, /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("rtAllowPrefix") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.routing.allowPrefix,
            disabled,
            label: config.routing.allowPrefix ? t("on") : t("off"),
            onChange: (value) => void patch({ routing: { ...config.routing, allowPrefix: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("rtEchoTarget"), hint: t("rtEchoTargetHint") }, /* @__PURE__ */ import_react5.default.createElement(
          Check,
          {
            checked: config.routing.echoTarget,
            disabled,
            label: config.routing.echoTarget ? t("on") : t("off"),
            onChange: (value) => void patch({ routing: { ...config.routing, echoTarget: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("rtFallback") }, /* @__PURE__ */ import_react5.default.createElement(
          Select,
          {
            value: config.routing.fallback,
            disabled,
            options: [
              { value: "latest", label: t("rtFallbackLatest") },
              { value: "intervention", label: t("rtFallbackIntervention") }
            ],
            onChange: (value) => void patch({ routing: { ...config.routing, fallback: value } })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("rtTableTtlDays"), hint: t("rtTableTtlDaysHint") }, /* @__PURE__ */ import_react5.default.createElement(
          NumInput,
          {
            value: config.routing.tableTtlDays,
            min: 1,
            max: 365,
            disabled,
            onCommit: (value) => void patch({ routing: { ...config.routing, tableTtlDays: value } })
          }
        ))), /* @__PURE__ */ import_react5.default.createElement(Section, { title: t("advanced") }, /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("logLevel") }, /* @__PURE__ */ import_react5.default.createElement(
          Select,
          {
            value: config.logLevel,
            disabled,
            options: [
              { value: "debug", label: "debug" },
              { value: "info", label: "info" },
              { value: "warn", label: "warn" },
              { value: "error", label: "error" }
            ],
            onChange: (value) => void patch({ logLevel: value })
          }
        )), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("dataDir") }, /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-mono", style: { wordBreak: "break-all" } }, config.dataDir)), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("configPath") }, /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-mono", style: { wordBreak: "break-all" } }, status.configPath)), /* @__PURE__ */ import_react5.default.createElement(Row, { label: t("status") }, /* @__PURE__ */ import_react5.default.createElement("span", { className: "tln-mono", style: { wordBreak: "break-all" } }, status.statePath))), config.channels.length === 0 ? /* @__PURE__ */ import_react5.default.createElement(Note, { tone: "warn" }, t("channelsHint")) : null);
      }
    
      // src/client/i18n.ts
      var ZH = {
        nav: "\u901A\u77E5\u52A9\u624B",
        title: "\u901A\u77E5\u52A9\u624B",
        subtitle: "\u628A DSH \u7684\u4F1A\u8BDD\u4E8B\u4EF6\u63A8\u5230\u4E00\u4E2A IM \u901A\u9053\uFF0C\u5E76\u80FD\u4ECE\u90A3\u91CC\u76F4\u63A5\u56DE\u590D\u3002",
        loading: "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026",
        loadFailed: "\u8BFB\u4E0D\u5230\u914D\u7F6E",
        saveFailed: "\u4FDD\u5B58\u5931\u8D25",
        saved: "\u5DF2\u4FDD\u5B58",
        save: "\u4FDD\u5B58",
        cancel: "\u53D6\u6D88",
        change: "\u6539",
        fill: "\u586B\u5199",
        notSet: "\u672A\u8BBE\u7F6E",
        retry: "\u91CD\u8BD5",
        reload: "\u91CD\u65B0\u8BFB\u53D6",
        noConnection: "\u6D4F\u89C8\u5668\u6CA1\u6709\u8FDE\u4E0A\u5BBF\u4E3B\uFF0C\u8FD9\u4E00\u9875\u73B0\u5728\u53EA\u80FD\u770B\uFF0C\u4E0D\u80FD\u6539\u3002",
        unsavedHint: "\u6539\u52A8\u4F1A\u7ACB\u5373\u5199\u5165 config.json \u5E76\u751F\u6548\uFF0C\u4E0D\u9700\u8981\u91CD\u542F\u3002",
        enabledLabel: "\u542F\u7528\u901A\u77E5",
        enabledHint: "\u5173\u6389\u4E4B\u540E\u4E0D\u518D\u63A8\u9001\u4EFB\u4F55\u901A\u77E5\u3002\u8BBE\u7F6E\u9875\u672C\u8EAB\u4ECD\u7136\u53EF\u7528\uFF0C\u65B9\u4FBF\u4F60\u628A\u5B83\u6253\u5F00\u3002",
        channels: "\u901A\u9053",
        channelsHint: "\u901A\u77E5\u901A\u8FC7\u8FD9\u91CC\u914D\u7F6E\u7684\u673A\u5668\u4EBA\u53D1\u51FA\u53BB\u3002\u591A\u4E2A\u901A\u9053\u65F6\u6309\u300C\u9ED8\u8BA4\u901A\u9053\u300D\u4F18\u5148\u3002",
        addChannel: "\u6DFB\u52A0\u901A\u9053",
        addQq: "\u6DFB\u52A0 QQ \u673A\u5668\u4EBA",
        addFeishu: "\u6DFB\u52A0\u98DE\u4E66\u673A\u5668\u4EBA",
        channelId: "\u6807\u8BC6",
        channelIdHint: "\u53EA\u7528\u4E8E\u533A\u5206\u901A\u9053\uFF0C\u968F\u4FBF\u8D77\u4E2A\u77ED\u540D\u5B57\uFF0C\u4F8B\u5982 qq-main\u3002",
        channelType: "\u7C7B\u578B",
        channelEnabled: "\u542F\u7528\u8FD9\u4E2A\u901A\u9053",
        remove: "\u5220\u9664",
        removeConfirm: "\u5220\u6389\u8FD9\u4E2A\u901A\u9053\uFF1F\u5220\u6389\u4E4B\u540E\u5B83\u5C31\u4E0D\u4F1A\u518D\u6536\u5230\u901A\u77E5\u4E86\u3002",
        appId: "AppID",
        appSecret: "AppSecret",
        secretClear: "\u6E05\u7A7A",
        secretHint: "\u51FA\u4E8E\u5B89\u5168\uFF0C\u5DF2\u4FDD\u5B58\u7684\u5BC6\u94A5\u4E0D\u4F1A\u56DE\u663E\uFF1B\u8FD9\u91CC\u7559\u7A7A\u8868\u793A\u4FDD\u6301\u539F\u503C\u3002",
        targetId: "\u76EE\u6807 ID",
        targetIdHintQq: "QQ \u5355\u804A\u91CC\u5C31\u662F\u4F60\u7684 openid\u3002\u7528\u300C\u626B\u7801\u7ED1\u5B9A\u300D\u53EF\u4EE5\u81EA\u52A8\u586B\u3002",
        targetIdHintFeishu: "\u98DE\u4E66\u7684\u63A5\u6536\u8005 ID\uFF0C\u5355\u804A\u65F6\u901A\u5E38\u662F openid\u3002",
        receiveIdType: "\u63A5\u6536\u8005\u7C7B\u578B",
        pushMode: "\u53D1\u9001\u65B9\u5F0F",
        pushActive: "\u4E3B\u52A8\u6D88\u606F",
        pushPassive: "\u88AB\u52A8\u56DE\u590D",
        pushModeHint: "\u4E3B\u52A8\u6D88\u606F\u6709\u914D\u989D\u4E0A\u9650\uFF08QQ 1000 \u6761/\u5929/\u7528\u6237\uFF09\uFF1B\u88AB\u52A8\u56DE\u590D\u53EA\u5728\u7528\u6237\u5148\u8BF4\u8BDD\u540E\u7684\u4E00\u6BB5\u65F6\u95F4\u5185\u53EF\u7528\u3002",
        bindLink: "\u7ED1\u5B9A\u94FE\u63A5",
        bindLinkHint: "\u673A\u5668\u4EBA\u5206\u4EAB\u94FE\u63A5\u3002\u98DE\u4E66\u7559\u7A7A\u4F1A\u7528 AppID \u63A8\u5BFC\uFF1BQQ \u6CA1\u6709\u53EF\u63A8\u5BFC\u7684\u94FE\u63A5\uFF0C\u9700\u8981\u624B\u586B\u3002",
        sessionFilter: "\u53EA\u63A8\u8FD9\u4E9B\u4F1A\u8BDD",
        sessionFilterHint: "\u6BCF\u884C\u4E00\u4E2A\u4F1A\u8BDD id\uFF0C\u7559\u7A7A\u8868\u793A\u5168\u90E8\u4F1A\u8BDD\u3002",
        defaultChannel: "\u9ED8\u8BA4\u901A\u9053",
        defaultChannelNone: "\uFF08\u4E0D\u6307\u5B9A\uFF0C\u6309\u914D\u7F6E\u987A\u5E8F\uFF09",
        setDefault: "\u8BBE\u4E3A\u9ED8\u8BA4",
        isDefault: "\u9ED8\u8BA4",
        qrBind: "\u626B\u7801\u7ED1\u5B9A",
        qrWorking: "\u6B63\u5728\u751F\u6210\u2026",
        qrTitle: "\u7528\u624B\u673A\u626B\u8FD9\u4E2A\u7801",
        qrWaiting: "\u7B49\u4F60\u7ED9\u673A\u5668\u4EBA\u53D1\u4E00\u6761\u6D88\u606F\u2026\uFF08\u4E5F\u53EF\u4EE5\u76F4\u63A5\u53D1\u300C\u7ED1\u5B9A\u300D\uFF09",
        qrDone: "\u7ED1\u5B9A\u6210\u529F\uFF0C\u76EE\u6807 ID \u5DF2\u81EA\u52A8\u586B\u5165\u3002",
        qrExpired: "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002",
        qrClose: "\u6536\u8D77",
        qrFallback: "\u626B\u4E0D\u52A8\u7684\u8BDD\uFF0C\u628A\u4E0B\u9762\u8FD9\u4E32\u94FE\u63A5\u590D\u5236\u5230\u624B\u673A\u4E0A\u6253\u5F00\uFF1A",
        test: "\u6D4B\u8BD5\u8FDE\u63A5",
        testing: "\u53D1\u9001\u4E2D\u2026",
        testOk: "\u6D4B\u8BD5\u6D88\u606F\u5DF2\u53D1\u51FA",
        testHint: "\u4F1A\u771F\u53D1\u4E00\u6761\u6D88\u606F\u3002\u6536\u5230\u5C31\u8BF4\u660E\u51ED\u636E\u548C\u76EE\u6807 ID \u90FD\u5BF9\u3002",
        runMode: "\u8FD0\u884C\u6A21\u5F0F",
        modeGlobal: "\u5168\u5C40",
        modeSession: "\u5355\u4F1A\u8BDD",
        modeGlobalHint: "\u6240\u6709\u4E3B\u4F1A\u8BDD\u7684\u4E8B\u4EF6\u90FD\u63A8\uFF0C\u6B63\u6587\u7CBE\u7B80\uFF0C\u56DE\u590D\u8D70\u4E09\u5C42\u8DEF\u7531\u3002",
        modeSessionHint: "\u53EA\u63A8\u7ED1\u5B9A\u7684\u90A3\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u6B63\u6587\u7ED9\u5168\u4E0A\u4E0B\u6587\uFF0C\u56DE\u590D\u96F6\u6B67\u4E49\u3002",
        boundSession: "\u7ED1\u5B9A\u4F1A\u8BDD",
        noBoundSession: "\u8FD8\u6CA1\u7ED1\u5B9A\u4F1A\u8BDD\u3002\u5728 IM \u91CC\u53D1\u300C/mode session <\u77EDid>\u300D\u5C31\u80FD\u7ED1\u5B9A\u3002",
        detailSessions: "\u989D\u5916\u5347\u7EA7\u4E3A\u8BE6\u7EC6\u6A21\u5F0F\u7684\u4F1A\u8BDD",
        detailNone: "\uFF08\u65E0\uFF09",
        events: "\u63A8\u54EA\u4E9B\u4E8B\u4EF6",
        eventsHint: "\u5173\u6389\u7684\u4E8B\u4EF6\u4E0D\u4F1A\u4EA7\u751F\u4EFB\u4F55\u901A\u77E5\u3002",
        evTurnEnd: "\u4EFB\u52A1\u5B8C\u6210",
        evError: "\u6267\u884C\u9519\u8BEF",
        evAborted: "\u624B\u52A8\u4E2D\u6B62",
        evPending: "\u7B49\u5F85\u6211\u56DE\u7B54 / \u6388\u6743 / \u8BA1\u5212\u786E\u8BA4",
        evMaxTokens: "Token \u8FBE\u5230\u4E0A\u9650",
        evIncludeSubagent: "\u5B50 Agent \u4E5F\u63A8",
        evIncludeSubagentHint: "\u9ED8\u8BA4\u9759\u9ED8\u3002\u4E00\u4E2A\u4EFB\u52A1\u53EF\u80FD\u6D3E\u51FA\u51E0\u5341\u4E2A\u5B50 Agent\uFF0C\u5168\u63A8\u4F1A\u5237\u5C4F\u3002",
        content: "\u6B63\u6587\u5185\u5BB9",
        contentHint: "\u63A7\u5236\u63A8\u8FC7\u53BB\u7684\u6D88\u606F\u91CC\u653E\u591A\u5C11\u4E1C\u897F\u3002",
        ctIncludeMetadata: "\u9644\u4E0A\u5143\u4FE1\u606F\uFF08\u9879\u76EE\u3001\u8017\u65F6\u3001\u5DE5\u5177\u6B21\u6570\uFF09",
        ctIncludeUserPrompt: "\u9644\u4E0A\u8FD9\u4E00\u8F6E\u7684\u7528\u6237\u63D0\u95EE",
        ctMaxBodyChars: "\u6B63\u6587\u4E0A\u9650\uFF08\u5B57\u7B26\uFF09",
        ctMaxBodyCharsHint: "\u8D85\u51FA\u4F1A\u88AB\u5206\u6BB5\u53D1\u9001\uFF0C\u9996\u6BB5\u5E26\u6309\u94AE\u3002\u5141\u8BB8 200 \u2013 20000\u3002",
        sessionContext: "\u5355\u4F1A\u8BDD\u6A21\u5F0F\u7684\u6B63\u6587\u7EC6\u8282",
        scIncludeAssistant: "\u5305\u542B\u52A9\u624B\u5168\u6587",
        scIncludeTools: "\u5305\u542B\u5DE5\u5177\u8C03\u7528\u5217\u8868",
        scIncludeTiming: "\u5305\u542B\u8017\u65F6",
        scPreviousTurns: "\u9644\u5E26\u524D\u51E0\u8F6E\uFF080 \u2013 20\uFF09",
        scIncludeUserPrompt: "\u5305\u542B\u7528\u6237\u63D0\u95EE",
        routing: "\u56DE\u590D\u8DEF\u7531",
        routingHint: "\u51B3\u5B9A\u4F60\u5728 IM \u91CC\u56DE\u4E00\u53E5\u8BDD\u65F6\uFF0C\u5B83\u88AB\u6295\u7ED9\u54EA\u4E2A\u4F1A\u8BDD\u3002",
        rtAllowPrefix: "\u5141\u8BB8\u300C\u77EDid \u5185\u5BB9\u300D\u524D\u7F00\u5B9A\u5411",
        rtEchoTarget: "\u56DE\u590D\u65F6\u56DE\u663E\u300C\u5DF2\u53D1\u7ED9 X\u300D",
        rtEchoTargetHint: "\u5173\u6389\u4E4B\u540E\u6295\u9012\u6210\u529F\u5C31\u4E0D\u518D\u56DE\u6267\u3002\u5EFA\u8BAE\u5F00\u7740\uFF1A\u6C89\u5E95\u7684\u901A\u77E5\u91CC\u5F88\u5BB9\u6613\u8BB0\u9519\u4F1A\u8BDD\u3002",
        rtFallback: "\u65E2\u6CA1\u6709\u5F15\u7528\u4E5F\u6CA1\u6709\u524D\u7F00\u65F6",
        rtFallbackLatest: "\u53D1\u7ED9\u6700\u65B0\u4E00\u6761\u901A\u77E5\u7684\u4F1A\u8BDD",
        rtFallbackIntervention: "\u53D1\u7ED9\u6700\u8FD1\u4E00\u6B21\u9700\u8981\u4EBA\u4ECB\u5165\u7684\u4F1A\u8BDD",
        rtTableTtlDays: "\u8DEF\u7531\u8868\u4FDD\u7559\u5929\u6570\uFF081 \u2013 365\uFF09",
        rtTableTtlDaysHint: "\u8D85\u8FC7\u8FD9\u4E2A\u5929\u6570\u7684\u65E7\u901A\u77E5\u88AB\u5F15\u7528\u65F6\uFF0C\u4F1A\u8D70\u515C\u5E95\u800C\u4E0D\u662F\u9759\u9ED8\u6295\u9519\u3002",
        advanced: "\u9AD8\u7EA7",
        logLevel: "\u65E5\u5FD7\u7EA7\u522B",
        dataDir: "\u6570\u636E\u76EE\u5F55",
        configPath: "\u914D\u7F6E\u6587\u4EF6",
        status: "\u72B6\u6001",
        statusRunning: "\u8FD0\u884C\u4E2D",
        statusDisabled: "\u5DF2\u505C\u7528",
        statusIdle: "\u672A\u542F\u52A8",
        statusPushed: "\u5DF2\u63A8\u9001 {n} \u6761",
        statusChannels: "\u901A\u9053 {ok}/{total} \u53EF\u7528",
        statusSince: "\u672C\u6B21\u542F\u52A8\u4E8E {time}",
        railQq: "QQ \u673A\u5668\u4EBA",
        railFeishu: "\u98DE\u4E66\u673A\u5668\u4EBA",
        scanAdd: "\u626B\u7801\u63A5\u5165\u673A\u5668\u4EBA",
        manualAdd: "\u624B\u52A8\u6DFB\u52A0",
        botEmpty: "\u8FD9\u4E2A\u7C7B\u578B\u4E0B\u8FD8\u6CA1\u6709\u673A\u5668\u4EBA\uFF0C\u70B9\u4E0A\u9762\u7684\u6309\u94AE\u52A0\u4E00\u4E2A\u3002",
        botCount: "{n} \u4E2A",
        botName: "\u540D\u79F0",
        botNameHint: "\u53EA\u5F71\u54CD\u8FD9\u4E00\u9875\u7684\u663E\u793A\uFF1B\u7559\u7A7A\u5C31\u7528\u6807\u8BC6\u3002",
        more: "\u66F4\u591A\u8BBE\u7F6E",
        backToList: "\u2190 \u8FD4\u56DE\u673A\u5668\u4EBA\u5217\u8868",
        summaryOff: "\u672A\u542F\u7528",
        summaryNoTarget: "\u672A\u7ED1\u5B9A\u76EE\u6807",
        tabRules: "\u901A\u77E5\u89C4\u5219",
        tabSessions: "\u4F1A\u8BDD\u8FC7\u6EE4",
        tabAdvanced: "\u9AD8\u7EA7",
        followGlobal: "\u8DDF\u968F\u5168\u5C40",
        custom: "\u81EA\u5B9A\u4E49",
        followGlobalHint: "\u7528\u5168\u5C40\u7684\u300C\u63A8\u54EA\u4E9B\u4E8B\u4EF6\u300D\u4E0E\u300C\u6B63\u6587\u5185\u5BB9\u300D\u3002",
        customHint: "\u8FD9\u4E00\u4E2A\u673A\u5668\u4EBA\u5355\u72EC\u8BBE\u7F6E\uFF0C\u4E0B\u9762\u7684\u5F00\u5173\u53EA\u5F71\u54CD\u5B83\u3002",
        scopeAll: "\u5173\u5FC3\u5168\u90E8\u4F1A\u8BDD",
        scopeFilter: "\u53EA\u5173\u5FC3\u5217\u8868\u91CC\u7684\u4F1A\u8BDD",
        scopeHint: "\u300C\u5173\u5FC3\u5168\u90E8\u4F1A\u8BDD\u300D\uFF1D\u6240\u6709\u4F1A\u8BDD\u7684\u4E8B\u4EF6\u90FD\u63A8\u7ED9\u5B83\uFF1B\u300C\u53EA\u5173\u5FC3\u5217\u8868\u300D\uFF1D\u53EA\u63A8\u4E0B\u9762\u5217\u51FA\u7684\u4F1A\u8BDD\u3002",
        groupChatId: "\u7FA4 ID",
        groupChatIdHint: "\u53EF\u9009\u3002\u586B\u4E86\u4E4B\u540E\u8FD9\u4E2A\u7FA4\u4E5F\u4F1A\u6536\u5230\u901A\u77E5\uFF08\u98DE\u4E66\u7528 chat_id\uFF0CQQ \u7528\u7FA4 openid\uFF09\u3002",
        wizard: "\u63A5\u5165\u5411\u5BFC",
        wizardHint: "\u56DB\u6B65\u8D70\u5B8C\u5C31\u80FD\u7528\u3002\u6BCF\u4E00\u6B65\u90FD\u53EF\u4EE5\u8DF3\u8FC7\u2014\u2014\u8DF3\u8FC7\u4E0D\u4F1A\u4E22\u6389\u5DF2\u7ECF\u4FDD\u5B58\u7684\u4E1C\u897F\u3002",
        stepLabel: "\u7B2C {n} \u6B65",
        step1: "\u521B\u5EFA\u673A\u5668\u4EBA",
        step2: "\u586B\u51ED\u636E",
        step3: "\u7ED1\u5B9A\u76EE\u6807",
        step4: "\u6D4B\u8BD5\u8FDE\u63A5",
        stepDone: "\u5DF2\u5B8C\u6210",
        stepTodo: "\u5F85\u5B8C\u6210",
        stepSkip: "\u8DF3\u8FC7",
        stepOpen: "\u5C55\u5F00",
        stepCollapse: "\u6536\u8D77",
        step1Qq: "\u70B9\u53F3\u4E0A\u89D2\u7684\u300C\u626B\u7801\u63A5\u5165\u673A\u5668\u4EBA\u300D\uFF0C\u7528\u624B\u673A QQ \u626B\u7801\u5E76\u6309\u63D0\u793A\u521B\u5EFA\u673A\u5668\u4EBA\uFF1A\u51ED\u636E\u4F1A\u81EA\u52A8\u586B\u597D\uFF0C\u4E0D\u7528\u624B\u6284\u3002\u4E5F\u53EF\u4EE5\u81EA\u5DF1\u5230 QQ \u5F00\u653E\u5E73\u53F0\u5EFA\u597D\uFF0C\u518D\u628A AppID / AppSecret \u586B\u5230\u7B2C 2 \u6B65\u3002",
        step1Feishu: "\u5230\u98DE\u4E66\u5F00\u653E\u5E73\u53F0\u5EFA\u4E00\u4E2A\u300C\u4F01\u4E1A\u81EA\u5EFA\u5E94\u7528\u300D\uFF0C\u5F00\u901A\u673A\u5668\u4EBA\u80FD\u529B\uFF0C\u518D\u628A\u5B83\u62C9\u8FDB\u4F60\u8981\u6536\u901A\u77E5\u7684\u4F1A\u8BDD\uFF08\u6216\u8005\u76F4\u63A5\u548C\u5B83\u5355\u804A\uFF09\u3002\u7136\u540E\u628A AppID / AppSecret \u586B\u5230\u7B2C 2 \u6B65\u3002",
        openQqPlatform: "\u6253\u5F00 QQ \u5F00\u653E\u5E73\u53F0",
        openFeishuPlatform: "\u6253\u5F00\u98DE\u4E66\u5F00\u653E\u5E73\u53F0",
        step2Hint: "AppID \u4E0D\u662F\u5BC6\u94A5\uFF0C\u968F\u65F6\u80FD\u6539\uFF1BAppSecret \u53EA\u5728\u4E0A\u884C\u65F6\u53D1\u4E00\u6B21\uFF0C\u4E4B\u540E\u4E0D\u518D\u56DE\u663E\u3002",
        step3Qq: "\u5148\u628A\u673A\u5668\u4EBA\u52A0\u4E3A\u597D\u53CB\uFF08\u6216\u626B\u673A\u5668\u4EBA\u81EA\u5DF1\u7684\u7801\u6253\u5F00\u5B83\uFF09\uFF0C\u7136\u540E\u70B9\u300C\u626B\u7801\u7ED1\u5B9A\u300D\uFF0C\u7ED9\u673A\u5668\u4EBA\u968F\u4FBF\u53D1\u4E00\u6761\u6D88\u606F\u2014\u2014\u76EE\u6807 ID \u4F1A\u81EA\u52A8\u586B\u4E0A\u3002",
        step3Feishu: "\u70B9\u300C\u626B\u7801\u7ED1\u5B9A\u300D\u751F\u6210\u4E8C\u7EF4\u7801\uFF0C\u7528\u98DE\u4E66\u626B\u5B83\u6253\u5F00\u8DDF\u673A\u5668\u4EBA\u7684\u4F1A\u8BDD\uFF0C\u968F\u4FBF\u53D1\u4E00\u6761\u6D88\u606F\u2014\u2014\u63A5\u6536\u8005 ID \u4F1A\u81EA\u52A8\u586B\u4E0A\u3002",
        provisionTitle: "\u7528\u624B\u673A QQ \u626B\u7801\u521B\u5EFA\u673A\u5668\u4EBA",
        provisionHint: "\u626B\u5B8C\u7801\u6309\u624B\u673A\u4E0A\u7684\u63D0\u793A\u8D70\uFF1A\u767B\u5F55 QQ \u2192 \u521B\u5EFA\u673A\u5668\u4EBA \u2192 \u786E\u8BA4\u6388\u6743\u3002\u8FD9\u4E2A\u7A97\u53E3\u4F1A\u4E00\u76F4\u7B49\u4F60\u3002",
        provisionStarting: "\u6B63\u5728\u5411 QQ \u7533\u8BF7\u4E8C\u7EF4\u7801\u2026",
        provisionScanned: "\u5DF2\u626B\u7801\uFF0C\u6B63\u5728\u7B49\u4F60\u5728\u624B\u673A\u4E0A\u786E\u8BA4\u2026",
        provisionConnecting: "\u62FF\u5230\u51ED\u636E\u4E86\uFF0C\u6B63\u5728\u5199\u5165\u914D\u7F6E\u2026",
        provisionDone: "\u63A5\u5165\u6210\u529F\uFF1AAppID\u3001AppSecret \u548C\u76EE\u6807 ID \u90FD\u5DF2\u81EA\u52A8\u586B\u597D\u3002",
        provisionExpired: "\u4E8C\u7EF4\u7801\u8FC7\u671F\u4E86\uFF0C\u91CD\u65B0\u751F\u6210\u4E00\u4E2A\u3002",
        provisionCancelled: "\u5DF2\u53D6\u6D88\u3002",
        provisionFailed: "\u626B\u7801\u63A5\u5165\u5931\u8D25",
        provisionRetry: "\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801",
        provisionFeishu: "\u98DE\u4E66\u4E0D\u7528\u626B\u7801\u521B\u5EFA\uFF0C\u6309\u7B2C 1 \u6B65\u5728\u5F00\u653E\u5E73\u53F0\u5EFA\u597D\u5E94\u7528\u5373\u53EF\uFF1B\u300C\u626B\u7801\u7ED1\u5B9A\u300D\u5728\u7B2C 3 \u6B65\u3002",
        on: "\u5F00",
        off: "\u5173",
        yes: "\u662F",
        no: "\u5426"
      };
      var EN = {
        nav: "Notify",
        title: "Notification assistant",
        subtitle: "Push DSH session events to one IM channel, and reply straight from there.",
        loading: "Loading configuration\u2026",
        loadFailed: "Could not read the configuration",
        saveFailed: "Save failed",
        saved: "Saved",
        save: "Save",
        cancel: "Cancel",
        change: "Change",
        fill: "Set",
        notSet: "Not set",
        retry: "Retry",
        reload: "Reload",
        noConnection: "The browser is not connected to the host, so this page is read-only right now.",
        unsavedHint: "Changes are written to config.json and take effect immediately \u2014 no restart needed.",
        enabledLabel: "Enable notifications",
        enabledHint: "When off, nothing is pushed. This page stays available so you can turn it back on.",
        channels: "Channels",
        channelsHint: "Notifications are sent through the bots configured here. The default channel wins.",
        addChannel: "Add channel",
        addQq: "Add QQ bot",
        addFeishu: "Add Feishu bot",
        channelId: "Id",
        channelIdHint: "Only used to tell channels apart. Something short, e.g. qq-main.",
        channelType: "Type",
        channelEnabled: "Enable this channel",
        remove: "Delete",
        removeConfirm: "Delete this channel? It will stop receiving notifications.",
        appId: "AppID",
        appSecret: "AppSecret",
        secretClear: "Clear",
        secretHint: "Saved secrets are never echoed back; leaving this empty keeps the current value.",
        targetId: "Target id",
        targetIdHintQq: 'In a QQ direct message this is your openid. "Bind by QR" can fill it in.',
        targetIdHintFeishu: "Feishu receiver id \u2014 usually an openid for direct messages.",
        receiveIdType: "Receiver type",
        pushMode: "Send mode",
        pushActive: "Proactive",
        pushPassive: "Passive reply",
        pushModeHint: "Proactive messages are quota-limited (QQ: 1000/day/user); passive replies work only shortly after the user speaks.",
        bindLink: "Bind link",
        bindLinkHint: "The bot share link. Feishu derives it from the AppID; QQ needs it typed in.",
        sessionFilter: "Only these sessions",
        sessionFilterHint: "One session id per line. Empty means every session.",
        defaultChannel: "Default channel",
        defaultChannelNone: "(none \u2014 config order)",
        setDefault: "Set default",
        isDefault: "Default",
        qrBind: "Bind by QR",
        qrWorking: "Generating\u2026",
        qrTitle: "Scan this with your phone",
        qrWaiting: 'Waiting for you to message the bot\u2026 (a plain "bind" works too)',
        qrDone: "Bound. The target id has been filled in.",
        qrExpired: "The QR code expired \u2014 generate a new one.",
        qrClose: "Collapse",
        qrFallback: "If scanning fails, copy this link onto your phone:",
        test: "Test connection",
        testing: "Sending\u2026",
        testOk: "Test message sent",
        testHint: "This really sends a message. If it arrives, the credentials and target id are correct.",
        runMode: "Run mode",
        modeGlobal: "Global",
        modeSession: "Single session",
        modeGlobalHint: "Every main session is pushed, briefly; replies go through three-layer routing.",
        modeSessionHint: "Only the bound session is pushed, with full context; replies are unambiguous.",
        boundSession: "Bound session",
        noBoundSession: 'No session bound yet. Send "/mode session <short-id>" in IM to bind one.',
        detailSessions: "Sessions upgraded to detailed",
        detailNone: "(none)",
        events: "Which events",
        eventsHint: "Disabled events produce no notification at all.",
        evTurnEnd: "Turn finished",
        evError: "Execution error",
        evAborted: "Aborted manually",
        evPending: "Waiting on me (question / approval / plan)",
        evMaxTokens: "Token limit reached",
        evIncludeSubagent: "Include sub-agents",
        evIncludeSubagentHint: "Silent by default \u2014 one task can spawn dozens of sub-agents.",
        content: "Message content",
        contentHint: "How much goes into the pushed message.",
        ctIncludeMetadata: "Include metadata (project, duration, tool count)",
        ctIncludeUserPrompt: "Include the user prompt of this turn",
        ctMaxBodyChars: "Body limit (characters)",
        ctMaxBodyCharsHint: "Longer bodies are sharded; the first shard carries the buttons. 200 \u2013 20000.",
        sessionContext: "Single-session detail",
        scIncludeAssistant: "Include full assistant text",
        scIncludeTools: "Include the tool-call list",
        scIncludeTiming: "Include timing",
        scPreviousTurns: "Include previous turns (0 \u2013 20)",
        scIncludeUserPrompt: "Include the user prompt",
        routing: "Reply routing",
        routingHint: "Decides which session a reply in IM is delivered to.",
        rtAllowPrefix: 'Allow the "<short-id> text" prefix',
        rtEchoTarget: 'Echo "sent to X" on delivery',
        rtEchoTargetHint: "With this off, successful delivery is silent. Keep it on: it is easy to mix up sessions.",
        rtFallback: "When there is neither a quote nor a prefix",
        rtFallbackLatest: "Send to the latest notified session",
        rtFallbackIntervention: "Send to the most recent session needing a human",
        rtTableTtlDays: "Keep the routing table for (days, 1 \u2013 365)",
        rtTableTtlDaysHint: "Quoting an older notification falls back instead of silently misrouting.",
        advanced: "Advanced",
        logLevel: "Log level",
        dataDir: "Data directory",
        configPath: "Config file",
        status: "Status",
        statusRunning: "Running",
        statusDisabled: "Disabled",
        statusIdle: "Not started",
        statusPushed: "{n} pushed",
        statusChannels: "{ok}/{total} channels up",
        statusSince: "Started at {time}",
        railQq: "QQ bots",
        railFeishu: "Feishu bots",
        scanAdd: "Add a bot by scanning",
        manualAdd: "Add manually",
        botEmpty: "No bots of this type yet \u2014 use the buttons above.",
        botCount: "{n}",
        botName: "Name",
        botNameHint: "Display name only; leave it empty to use the id.",
        more: "More settings",
        backToList: "\u2190 Back to the bot list",
        summaryOff: "disabled",
        summaryNoTarget: "no target bound",
        tabRules: "Notify rules",
        tabSessions: "Sessions",
        tabAdvanced: "Advanced",
        followGlobal: "Follow global",
        custom: "Custom",
        followGlobalHint: "Use the global \u201Cwhich events\u201D and \u201Cmessage body\u201D settings.",
        customHint: "Configured for this bot alone; the switches below affect nothing else.",
        scopeAll: "All sessions",
        scopeFilter: "Only the listed sessions",
        scopeHint: "\u201CAll sessions\u201D pushes every session to this bot; \u201COnly the listed sessions\u201D pushes just the ids below.",
        groupChatId: "Group id",
        groupChatIdHint: "Optional. When set, that group is notified too (chat_id on Feishu, group openid on QQ).",
        wizard: "Setup guide",
        wizardHint: "Four steps and you are done. Every step can be skipped \u2014 skipping never discards what is saved.",
        stepLabel: "Step {n}",
        step1: "Create the bot",
        step2: "Enter credentials",
        step3: "Bind a target",
        step4: "Test the connection",
        stepDone: "Done",
        stepTodo: "To do",
        stepSkip: "Skip",
        stepOpen: "Open",
        stepCollapse: "Close",
        step1Qq: "Click \u201CAdd a bot by scanning\u201D, scan with QQ, and create the bot in the flow: the credentials are filled in for you. You can also build the bot on the QQ open platform yourself and put the AppID / AppSecret into step 2.",
        step1Feishu: "Create an enterprise self-built app on the Feishu open platform, enable its bot capability, and add it to the chat you want notifications in (or just DM it). Then put the AppID / AppSecret into step 2.",
        openQqPlatform: "Open the QQ open platform",
        openFeishuPlatform: "Open the Feishu open platform",
        step2Hint: "The AppID is not a secret and can be changed any time; the AppSecret is sent once and never echoed back.",
        step3Qq: "Add the bot as a friend first (or scan the bot\u2019s own code to open it), then click \u201CScan to bind\u201D and send the bot any message \u2014 the target id is filled in automatically.",
        step3Feishu: "Click \u201CScan to bind\u201D, scan the code with Feishu to open the chat with the bot, and send it any message \u2014 the receiver id is filled in automatically.",
        provisionTitle: "Scan with mobile QQ to create the bot",
        provisionHint: "After scanning, follow the prompts on your phone: sign in to QQ \u2192 create the bot \u2192 confirm. This window keeps waiting for you.",
        provisionStarting: "Asking QQ for a QR code\u2026",
        provisionScanned: "Scanned \u2014 confirm on your phone\u2026",
        provisionConnecting: "Credentials received, writing the configuration\u2026",
        provisionDone: "Connected: the AppID, AppSecret and target id are all filled in.",
        provisionExpired: "The QR code expired \u2014 generate a new one.",
        provisionCancelled: "Cancelled.",
        provisionFailed: "Scan-based onboarding failed",
        provisionRetry: "New QR code",
        provisionFeishu: "Feishu does not use scan-based creation: build the app on the open platform as in step 1. \u201CScan to bind\u201D is step 3.",
        on: "on",
        off: "off",
        yes: "yes",
        no: "no"
      };
      var DICTS = { zh: ZH, en: EN };
      function detectLang() {
        try {
          const root = typeof document === "undefined" ? void 0 : document.documentElement;
          const declared = root?.getAttribute("lang") ?? root?.lang;
          if (declared) return /^en\b/i.test(declared) ? "en" : "zh";
          const nav = typeof navigator === "undefined" ? void 0 : navigator.language;
          if (nav) return /^en\b/i.test(nav) ? "en" : "zh";
        } catch {
        }
        return "zh";
      }
      function dictOf(lang) {
        return DICTS[lang] ?? ZH;
      }
      function translate(lang, key, vars) {
        const template = dictOf(lang)[key];
        if (!vars) return template;
        return template.replace(
          /\{(\w+)\}/g,
          (_match, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`
        );
      }
      function createTranslator(lang) {
        return (key, vars) => translate(lang, key, vars);
      }
    
      // src/client/styles.ts
      var STYLE_ID = "dsh-tlnotify-client-styles";
      var CLIENT_CSS = `
    .tln-page {
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding: 4px 2px 32px;
      font-family: var(--dsw-font-family, inherit);
      color: var(--dsw-alias-label-primary, #1a1a1a);
      font-size: 13px;
      line-height: 1.6;
    }
    
    .tln-head { display: flex; flex-direction: column; gap: 4px; }
    .tln-title { font-size: 16px; font-weight: 600; }
    .tln-subtitle { color: var(--dsw-alias-label-secondary, #666); }
    .tln-hint { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 1.55; }
    
    .tln-statusbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      padding: 10px 12px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 10px;
      background: var(--dsw-alias-bg-base, transparent);
    }
    .tln-status-item { display: inline-flex; align-items: center; gap: 6px; }
    .tln-status-item + .tln-status-item::before {
      content: '';
      width: 1px;
      height: 12px;
      margin-right: 8px;
      background: var(--dsw-alias-border-l3, rgba(127,127,127,.28));
    }
    
    .tln-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, #999); }
    .tln-dot-on { background: var(--dsw-alias-state-business-primary, #2f7d32); }
    .tln-dot-warn { background: #d08700; }
    .tln-dot-off { background: var(--dsw-alias-label-tertiary, #999); }
    
    .tln-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 12px;
      background: var(--dsw-alias-bg-base, transparent);
    }
    .tln-section-head { display: flex; flex-direction: column; gap: 2px; }
    .tln-section-title { font-weight: 600; font-size: 13px; }
    
    .tln-row {
      display: grid;
      grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
      gap: 10px 14px;
      align-items: start;
    }
    .tln-row-label { padding-top: 6px; color: var(--dsw-alias-label-secondary, #666); }
    .tln-row-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    
    .tln-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .tln-grow { flex: 1 1 180px; min-width: 0; }
    
    .tln-input,
    .tln-select,
    .tln-textarea {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: 6px 9px;
      font: inherit;
      color: inherit;
      background: var(--dsw-alias-bg-base, transparent);
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
      border-radius: 8px;
      outline: none;
    }
    .tln-input:focus,
    .tln-select:focus,
    .tln-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #2f7d32); }
    .tln-input:disabled,
    .tln-select:disabled,
    .tln-textarea:disabled { opacity: .55; }
    .tln-textarea { resize: vertical; min-height: 56px; font-family: inherit; }
    .tln-input-num { max-width: 120px; }
    
    .tln-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 12px;
      font: inherit;
      color: inherit;
      background: var(--dsw-alias-bg-base, transparent);
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .tln-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
    .tln-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
    .tln-btn:disabled { opacity: .5; cursor: default; }
    .tln-btn-primary {
      color: #fff;
      background: var(--dsw-alias-state-business-primary, #2f7d32);
      border-color: transparent;
    }
    .tln-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
    .tln-btn-danger { color: #c0392b; border-color: rgba(192,57,43,.45); }
    .tln-btn-sm { padding: 3px 9px; font-size: 12px; }
    
    .tln-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .tln-check input { margin: 0; flex: none; }
    .tln-check-disabled { opacity: .55; cursor: default; }
    
    .tln-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32)); border-radius: 8px; overflow: hidden; }
    .tln-seg > button {
      padding: 5px 14px;
      font: inherit;
      color: inherit;
      background: transparent;
      border: none;
      border-right: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      cursor: pointer;
    }
    .tln-seg > button:last-child { border-right: none; }
    .tln-seg > button[aria-pressed='true'] {
      color: #fff;
      background: var(--dsw-alias-state-business-primary, #2f7d32);
    }
    
    .tln-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 10px;
    }
    .tln-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .tln-card-head .tln-grow { flex: 1 1 auto; }
    
    .tln-note {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tln-note-ok { color: #1f7a34; border-color: rgba(31,122,52,.4); }
    .tln-note-warn { color: #9a6a00; border-color: rgba(154,106,0,.4); }
    .tln-note-error { color: #c0392b; border-color: rgba(192,57,43,.4); }
    
    .tln-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
      color: var(--dsw-alias-label-secondary, #666);
    }
    
    .tln-qr { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
    .tln-qr-canvas {
      padding: 10px;
      background: #fff;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 10px;
      line-height: 0;
    }
    .tln-qr svg { display: block; width: 208px; height: 208px; }
    
    .tln-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .tln-spacer { flex: 1 1 auto; }
    
    /* \u2500\u2500 \u6BCF\u673A\u5668\u4EBA\u8BBE\u7F6E\uFF1A\u901A\u9053\u680F + \u673A\u5668\u4EBA\u5361\u7247 + \u5B50\u9875 + \u63A5\u5165\u5411\u5BFC \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    
    .tln-rail {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
    }
    .tln-rail-tab {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      padding: 5px 12px;
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      cursor: pointer;
    }
    .tln-rail-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
    .tln-rail-tab[data-active='true'] {
      color: #fff;
      background: var(--dsw-alias-state-business-primary, #2f7d32);
    }
    .tln-rail-name { font-weight: 600; }
    .tln-rail-count { font-size: 12px; opacity: .8; }
    
    .tln-bots { display: flex; flex-direction: column; gap: 10px; }
    .tln-panel-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    
    .tln-botCard {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 10px;
      overflow: hidden;
    }
    .tln-botCard[data-open='true'] { border-color: var(--dsw-alias-state-business-primary, #2f7d32); }
    .tln-botCard-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
    }
    .tln-botCard-toggle {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 0;
      font: inherit;
      color: inherit;
      text-align: left;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .tln-botCard-name { font-weight: 600; }
    .tln-botCard-id { flex: none; }
    .tln-botCard-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 0 12px 12px;
    }
    .tln-caret { flex: none; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; }
    
    .tln-subpage { display: flex; flex-direction: column; gap: 12px; }
    .tln-subpage-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .tln-tabs { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32)); border-radius: 8px; overflow: hidden; }
    .tln-tab {
      padding: 5px 14px;
      font: inherit;
      color: inherit;
      background: transparent;
      border: none;
      border-right: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      cursor: pointer;
    }
    .tln-tab:last-child { border-right: none; }
    .tln-tab[data-active='true'] {
      color: #fff;
      background: var(--dsw-alias-state-business-primary, #2f7d32);
    }
    
    .tln-wizard {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border: 1px dashed var(--dsw-alias-border-l3, rgba(127,127,127,.32));
      border-radius: 10px;
    }
    .tln-step {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 8px;
    }
    .tln-step-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      font: inherit;
      color: inherit;
      text-align: left;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .tln-step-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
    .tln-step-index { flex: none; color: var(--dsw-alias-label-secondary, #666); font-size: 12px; }
    .tln-step-title { font-weight: 600; }
    .tln-step-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 0 10px 10px;
    }
    
    .tln-qr-layout { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
    .tln-qr-img {
      padding: 10px;
      background: #fff;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 10px;
      line-height: 0;
    }
    .tln-qr-side { display: flex; flex: 1 1 220px; flex-direction: column; gap: 6px; min-width: 0; }
    
    .tln-link {
      padding: 0;
      font: inherit;
      color: var(--dsw-alias-state-business-primary, #2f7d32);
      text-align: left;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    
    .tln-busy { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; }
    
    .tln-kv { display: grid; grid-template-columns: minmax(80px, 140px) minmax(0, 1fr); gap: 4px 12px; font-size: 12px; }
    .tln-kv dt { color: var(--dsw-alias-label-secondary, #666); }
    .tln-kv dd { margin: 0; word-break: break-all; }
    
    .tln-fatal { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; }
    `;
      var installed = 0;
      function ensureClientStyles() {
        if (typeof document === "undefined") return false;
        installed += 1;
        if (document.getElementById(STYLE_ID)) return false;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CLIENT_CSS;
        document.head.appendChild(style);
        return true;
      }
      function removeClientStyles() {
        if (typeof document === "undefined") return;
        installed = Math.max(0, installed - 1);
        if (installed > 0) return;
        document.getElementById(STYLE_ID)?.remove();
      }
    
      // src/client/index.tsx
      var inject = ["slots"];
      function warn(ctx, message, error) {
        try {
          const queried = typeof ctx.get === "function" ? ctx.get("logger") : void 0;
          const logger = queried ?? ctx.logger;
          logger?.warn?.(message, error);
        } catch {
        }
      }
      function useLang() {
        const [lang, setLang] = import_react6.default.useState(() => detectLang());
        import_react6.default.useEffect(() => {
          if (typeof document === "undefined" || typeof MutationObserver === "undefined") return void 0;
          const observer = new MutationObserver(() => setLang(detectLang()));
          try {
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "class"] });
          } catch {
            return void 0;
          }
          return () => observer.disconnect();
        }, []);
        return lang;
      }
      function apply(ctx) {
        if (typeof document === "undefined") return;
        const slots = ctx.slots;
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
          warn(ctx, "tlnotify: \u5BBF\u4E3B\u6CA1\u6709 slots \u670D\u52A1\uFF0C\u8BBE\u7F6E\u9875\u65E0\u6CD5\u6302\u8F7D\u3002");
          return;
        }
        try {
          ensureClientStyles();
        } catch (error) {
          warn(ctx, "tlnotify: \u6CE8\u5165\u6837\u5F0F\u5931\u8D25\uFF0C\u9875\u9762\u4F1A\u5931\u53BB\u5916\u89C2\u4F46\u4ECD\u53EF\u7528\u3002", error);
        }
        const Section2 = () => {
          const lang = useLang();
          const t = import_react6.default.useMemo(() => createTranslator(lang), [lang]);
          return /* @__PURE__ */ import_react6.default.createElement(SettingsPage, { ctx, t });
        };
        Section2.displayName = "TlnotifySettingsSection";
        try {
          slots.inject(
            "settings.section",
            () => slots.register(
              {
                name: "settings.section",
                id: "tlnotify",
                order: 60,
                label: () => translate(detectLang(), "nav")
              },
              Section2
            )
          );
        } catch (error) {
          warn(ctx, "tlnotify: \u6CE8\u518C\u8BBE\u7F6E\u9875\u5931\u8D25\u3002", error);
        }
        ctx.effect?.(() => () => removeClientStyles(), "tlnotify: client mounts");
      }
      return __toCommonJS(entry_exports);
    })();
    
    return __tlnotify_client_exports;
  }
});
