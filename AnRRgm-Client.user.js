// ==UserScript==
// @name         AnRRgm Client
// @namespace    local:anrrgm-client:gimkit
// @version      3.2.1
// @description  AnRRgm Client: a locally extended Gimkit userscript with module controls and Don't Look Down movement tools.
// @author       AnRRgm; original client by Zyrox client
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2296%22%20height%3D%2296%22%20viewBox%3D%220%200%2096%2096%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23ff4747%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23922d57%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2223%22%20fill%3D%22%2317171d%22%2F%3E%3Crect%20x%3D%224%22%20y%3D%224%22%20width%3D%2288%22%20height%3D%2288%22%20rx%3D%2219%22%20fill%3D%22url%28%23g%29%22%2F%3E%3Cpath%20d%3D%22M14%2067%2029%2028h10l15%2039H43l-3-9H27l-3%209zm16-18h7l-3.5-11z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M56%2028h13c12%200%2018%205%2018%2014%200%206-3%2010-8%2012l10%2013H77L66%2053v14H56zm10%209v8h4c5%200%207-1%207-4s-2-4-7-4z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E
// @license      MIT
// @grant        none
// @sandbox      raw
// @noframes
// @homepageURL   https://github.com/AidenRTRRgfdm/AnRRgm-Client
// @source        https://github.com/AidenRTRRgfdm/AnRRgm-Client
// ==/UserScript==

(() => {
  "use strict";

  // Some userscript runtimes execute bundled code that expects a global `Module`.
  // with `enable/disable` methods. Provide a minimal compatible fallback.
  if (typeof globalThis.Module === "undefined") {
    globalThis.Module = class Module {
      constructor(name = "Module", options = {}) {
        this.name = name;
        this.enabled = false;
        this.onEnable = typeof options.onEnable === "function" ? options.onEnable : () => {};
        this.onDisable = typeof options.onDisable === "function" ? options.onDisable : () => {};
      }

      enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.onEnable();
      }

      disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.onDisable();
      }
    };
  }

  if (window.__ANRRGM_UI_MOUNTED__) return;
  window.__ANRRGM_UI_MOUNTED__ = true;

  // ---------------------------------------------------------------------------
  // GIMKIT QUESTION FLOW (reverse-engineering notes)
  // ---------------------------------------------------------------------------
  // Short answer to: "is Gimkit choosing questions randomly on the client?"
  // -> Mostly no. The client *renders* and submits answers, but the server is the
  //    authority that sends/updates question payloads and validates outcomes.
  //
  // What we currently observe in packet captures (Classic / Draw That / Tycoon-like
  // modes) from this repo's test scripts and runtime hooks:
  // 1) Game traffic is a WebSocket on *.gimkitconnect.com, transported either as
  //    Blueboat-style msgpack events or Colyseus room messages.
  // 2) Question content appears in inbound server messages (ex: STATE_UPDATE /
  //    device state changes) as fields such as prompt/term/answers/correct index
  //    depending on mode implementation.
  // 3) The client sends player actions (selected answer, interaction, etc.) but
  //    does not become source-of-truth for score/currency/progression.
  // 4) "Random" ordering is usually server-side selection/shuffle from the active
  //    Kit/question pool; each client receives the next question state from server.
  //
  // Practical implication for modules:
  // - Auto-answer and "question reveal" logic should parse inbound socket state,
  //   not attempt local RNG prediction.
  // - Patching UI-only state can desync quickly because authoritative state is
  //   continuously pushed from server.
  //
  // Useful references inside this repo:
  // - tests/drawit-dump.js      (logs term-like answer candidates from STATE_UPDATE)
  // - tests/classic-autoanswer.js (classic answer extraction + submit path)
  // - tests/classic-logger.js     (general packet/event logging helpers)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // AUTO-ANSWER PAGE-CONTEXT INJECTION
  // Injected as a real <script> tag so it runs in page scope and patches
  // window.WebSocket BEFORE Gimkit creates its connection.
  // Mirrors autoanswer.js 1:1, but exposes window.__anrrgmAutoAnswer.start/stop
  // so the AnRRgm module toggle controls it.
  // ---------------------------------------------------------------------------
  (function injectAutoAnswerPageContext() {
    function pageMain() {
      const LOG = "[AutoAnswer][page]";
      const colyseusProtocol = { ROOM_DATA: 13 };

      function msgpackEncode(value) {
        const bytes = [];
        const deferred = [];
        const write = (input) => {
          const type = typeof input;
          if (type === "string") {
            let len = 0;
            for (let i = 0; i < input.length; i++) {
              const code = input.charCodeAt(i);
              if (code < 128) len++; else if (code < 2048) len += 2; else if (code < 55296 || code > 57343) len += 3; else { i++; len += 4; }
            }
            if (len < 32) bytes.push(160 | len); else if (len < 256) bytes.push(217, len); else bytes.push(218, len >> 8, len & 255);
            deferred.push({ type: "string", value: input, offset: bytes.length });
            bytes.length += len;
            return;
          }
          if (type === "number") {
            if (Number.isInteger(input) && input >= 0 && input < 128) { bytes.push(input); return; }
            if (Number.isInteger(input) && input >= 0 && input < 65536) { bytes.push(205, input >> 8, input & 255); return; }
            bytes.push(203); deferred.push({ type: "float64", value: input, offset: bytes.length }); bytes.length += 8; return;
          }
          if (type === "boolean") { bytes.push(input ? 195 : 194); return; }
          if (input == null) { bytes.push(192); return; }
          if (Array.isArray(input)) {
            const len = input.length;
            if (len < 16) bytes.push(144 | len); else bytes.push(220, len >> 8, len & 255);
            for (const item of input) write(item);
            return;
          }
          const keys = Object.keys(input);
          const len = keys.length;
          if (len < 16) bytes.push(128 | len); else bytes.push(222, len >> 8, len & 255);
          for (const key of keys) { write(key); write(input[key]); }
        };
        write(value);
        const view = new DataView(new ArrayBuffer(bytes.length));
        for (let i = 0; i < bytes.length; i++) view.setUint8(i, bytes[i] & 255);
        for (const part of deferred) {
          if (part.type === "float64") { view.setFloat64(part.offset, part.value); continue; }
          let offset = part.offset;
          const s = part.value;
          for (let i = 0; i < s.length; i++) {
            let code = s.charCodeAt(i);
            if (code < 128) view.setUint8(offset++, code);
            else if (code < 2048) { view.setUint8(offset++, 192 | (code >> 6)); view.setUint8(offset++, 128 | (code & 63)); }
            else { view.setUint8(offset++, 224 | (code >> 12)); view.setUint8(offset++, 128 | ((code >> 6) & 63)); view.setUint8(offset++, 128 | (code & 63)); }
          }
        }
        return view.buffer;
      }

      function msgpackDecode(buffer, startOffset = 0) {
        const view = new DataView(buffer);
        let offset = startOffset;
        const readString = (len) => {
          let out = "";
          const end = offset + len;
          while (offset < end) {
            const byte = view.getUint8(offset++);
            if ((byte & 0x80) === 0) out += String.fromCharCode(byte);
            else if ((byte & 0xe0) === 0xc0) out += String.fromCharCode(((byte & 0x1f) << 6) | (view.getUint8(offset++) & 0x3f));
            else out += String.fromCharCode(((byte & 0x0f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f));
          }
          return out;
        };
        const read = () => {
          const token = view.getUint8(offset++);
          if (token < 0x80) return token;
          if (token < 0x90) { const size = token & 0x0f; const map = {}; for (let i = 0; i < size; i++) map[read()] = read(); return map; }
          if (token < 0xa0) { const size = token & 0x0f; const arr = new Array(size); for (let i = 0; i < size; i++) arr[i] = read(); return arr; }
          if (token < 0xc0) return readString(token & 0x1f);
          if (token > 0xdf) return token - 256;
          switch (token) {
            case 192: return null;
            case 194: return false;
            case 195: return true;
            case 202: { const n = view.getFloat32(offset); offset += 4; return n; }
            case 203: { const n = view.getFloat64(offset); offset += 8; return n; }
            case 204: { const n = view.getUint8(offset); offset += 1; return n; }
            case 205: { const n = view.getUint16(offset); offset += 2; return n; }
            case 206: { const n = view.getUint32(offset); offset += 4; return n; }
            case 208: { const n = view.getInt8(offset); offset += 1; return n; }
            case 209: { const n = view.getInt16(offset); offset += 2; return n; }
            case 210: { const n = view.getInt32(offset); offset += 4; return n; }
            case 217: { const n = view.getUint8(offset); offset += 1; return readString(n); }
            case 218: { const n = view.getUint16(offset); offset += 2; return readString(n); }
            case 220: { const size = view.getUint16(offset); offset += 2; const arr = new Array(size); for (let i = 0; i < size; i++) arr[i] = read(); return arr; }
            case 222: { const size = view.getUint16(offset); offset += 2; const map = {}; for (let i = 0; i < size; i++) map[read()] = read(); return map; }
            default: return null;
          }
        };
        const value = read();
        return { value, offset };
      }

      function parseChangePacket(packet) {
        const out = [];
        for (const change of packet?.changes || []) {
          const data = {};
          const keys = change[1].map((index) => packet.values[index]);
          for (let i = 0; i < keys.length; i++) data[keys[i]] = change[2][i];
          out.push({ id: change[0], data });
        }
        return out;
      }

      class LocalSocketManager extends EventTarget {
        constructor() {
          super();
          this.socket = null;
          this.transportType = "unknown";
          this.blueboatRoomId = null;
          this.playerId = null;
          this.install();
        }
        install() {
          const manager = this;
          const NativeWebSocket = window.WebSocket;
          window.WebSocket = class extends NativeWebSocket {
            constructor(url, protocols) {
              super(url, protocols);
              if (String(url || "").includes("gimkitconnect.com")) manager.registerSocket(this);
            }
            send(data) {
              manager.onSend(data);
              super.send(data);
            }
          };
        }
        registerSocket(socket) {
          this.socket = socket;
          console.log(LOG, "Registered WebSocket", socket.url);
          socket.addEventListener("message", (e) => {
            const firstByte = (() => {
              try {
                return new Uint8Array(e.data)[0];
              } catch (_) {
                return null;
              }
            })();
            if (this.transportType === "unknown" && firstByte != null) {
              this.transportType = firstByte === 4 ? "blueboat" : "colyseus";
            }
            if (this.transportType === "blueboat") {
              const decoded = this.decodeBlueboat(e.data);
              if (!decoded) return;
              this.dispatchEvent(new CustomEvent("blueboatMessage", { detail: decoded }));
              if (typeof decoded.eventName === "string" && decoded.eventName.startsWith("message-")) {
                this.blueboatRoomId = decoded.eventName.slice("message-".length);
              }
            } else {
              const decoded = this.decodeColyseus(e.data);
              if (!decoded) return;
              this.dispatchEvent(new CustomEvent("colyseusMessage", { detail: decoded }));
              if (decoded.type === "AUTH_ID") {
                this.playerId = decoded.message;
                console.log(LOG, "Got player id", this.playerId);
              }
              if (decoded.type === "DEVICES_STATES_CHANGES") {
                const parsed = parseChangePacket(decoded.message);
                this.dispatchEvent(new CustomEvent("deviceChanges", { detail: parsed }));
              }
            }
          });
        }
        decodeBlueboat(data) {
          const bytes = new Uint8Array(data);
          if (!bytes.byteLength || bytes[0] !== 4) return null;
          const decoded = msgpackDecode(data.slice(1), 0)?.value;
          const payload = Array.isArray(decoded?.data) ? decoded.data[1] : decoded?.data;
          return {
            eventName: Array.isArray(decoded?.data) ? decoded.data[0] : null,
            payload,
          };
        }
        onSend(data) {
          if (this.transportType !== "blueboat") return;
          const decoded = this.decodeBlueboat(data);
          if (!decoded) return;
          if (decoded?.payload?.room) this.blueboatRoomId = decoded.payload.room;
          if (decoded?.payload?.roomId) this.blueboatRoomId = decoded.payload.roomId;
        }
        decodeColyseus(data) {
          const bytes = new Uint8Array(data);
          if (bytes[0] !== colyseusProtocol.ROOM_DATA) return null;
          const first = msgpackDecode(data, 1);
          if (!first) return null;
          let message;
          if (bytes.byteLength > first.offset) {
            const second = msgpackDecode(data, first.offset);
            message = second?.value;
          }
          return { type: first.value, message };
        }
        sendMessage(channel, payload) {
          if (!this.socket) return;
          if (this.transportType === "blueboat") {
            if (!this.blueboatRoomId) return;
            const encoded = msgpackEncode({
              type: 2,
              data: ["blueboat_SEND_MESSAGE", { room: this.blueboatRoomId, key: channel, data: payload }],
              options: { compress: true },
              nsp: "/",
            });
            const out = new Uint8Array(1 + encoded.byteLength);
            out[0] = 4;
            out.set(new Uint8Array(encoded), 1);
            this.socket.send(out.buffer);
            return;
          }
          const header = new Uint8Array([colyseusProtocol.ROOM_DATA]);
          const a = new Uint8Array(msgpackEncode(channel));
          const b = new Uint8Array(msgpackEncode(payload));
          const packet = new Uint8Array(header.length + a.length + b.length);
          packet.set(header, 0);
          packet.set(a, header.length);
          packet.set(b, header.length + a.length);
          this.socket.send(packet);
        }
      }

      const socketManager = window.socketManager || new LocalSocketManager();
      window.socketManager = socketManager;

      const state = {
        questions: [],
        questionById: new Map(),
        answerDeviceId: null,
        currentQuestionId: null,
        questionIdList: [],
        currentQuestionIndex: -1,
        sentQuestionIds: new Set(),
        isPardyMode: false,
        pardyCurrentQuestionId: null,
        pardyQuestionStatus: null,
        pardyAskQuestionId: null,
        pardyAskReadyAt: 0,
        pardyAskTimerId: null,
        lastPardyAnsweredQuestionId: null,
        lastPardySkipReason: null,
      };

      function setQuestions(questions) {
        state.questions = Array.isArray(questions) ? questions : [];
        const nextQuestionById = new Map();
        for (const question of state.questions) {
          const id = question?._id || question?.id;
          if (id) { nextQuestionById.set(id, question); nextQuestionById.set(String(id), question); }
        }
        state.questionById = nextQuestionById;
      }

      function asArray(value) {
        if (Array.isArray(value)) return value;
        return value == null ? [] : [value];
      }

      function parseQuestionAnswer(question) {
        if (!question) return null;
        const answers = Array.isArray(question.answers) ? question.answers : [];
        if (!answers.length) return null;
        if (question.type === "text") return answers[0]?.text || null;
        const correct = answers.find((a) => a?.correct) || answers[0];
        return correct?.id || correct?._id || correct?.text || null;
      }

      function findQuestionById(id) {
        if (id == null) return null;
        return state.questionById.get(id) || state.questionById.get(String(id)) || null;
      }

      function normalizeQuestionId(questionId) {
        if (questionId == null) return null;
        return String(questionId);
      }

      function setCurrentQuestionIndex(nextIndex) {
        if (!Number.isInteger(nextIndex)) return;
        if (state.currentQuestionIndex !== -1 && nextIndex < state.currentQuestionIndex) {
          state.sentQuestionIds.clear();
        }
        state.currentQuestionIndex = nextIndex;
      }

      function resetAnsweredCache() {
        state.sentQuestionIds.clear();
        state.lastPardyAnsweredQuestionId = null;
        state.pardyAskQuestionId = null;
        state.pardyAskReadyAt = 0;
        if (state.pardyAskTimerId) { clearTimeout(state.pardyAskTimerId); state.pardyAskTimerId = null; }
      }

      function normalizeSpecialGameTypes(value) {
        return asArray(value).map((item) => String(item || "").toUpperCase());
      }

      function isPardySpecialGameType(value) {
        return normalizeSpecialGameTypes(value).includes("PARDY");
      }

      function logPardySkip(reason) {
        if (state.lastPardySkipReason === reason) return;
        state.lastPardySkipReason = reason;
        console.log(LOG, "PARDY auto-answer waiting:", reason);
      }

      function setPardyMode(enabled, source) {
        if (!enabled) return;
        if (!state.isPardyMode) {
          state.isPardyMode = true;
          console.log(LOG, "Detected PARDY game type from", source || "game state", "- using PARDY answer flow when Auto Answer is enabled");
        }
      }

      function readStateUpdateValue(updateValue, wantedKey) {
        for (const item of asArray(updateValue)) {
          const value = item?.value;
          if (value?.key === wantedKey) return value.value;
          if (item?.key === wantedKey) return item.value;
        }
        return null;
      }

      function applyPardyQuestionId(questionId) {
        const normalizedQuestionId = normalizeQuestionId(questionId);
        if (!normalizedQuestionId) return;
        if (state.pardyCurrentQuestionId !== normalizedQuestionId) {
          state.pardyCurrentQuestionId = normalizedQuestionId;
          state.currentQuestionId = questionId;
          state.pardyQuestionStatus = null;
          state.pardyAskQuestionId = null;
          state.pardyAskReadyAt = 0;
          if (state.pardyAskTimerId) { clearTimeout(state.pardyAskTimerId); state.pardyAskTimerId = null; }
          state.lastPardySkipReason = null;
          console.log(LOG, "PARDY current question set", normalizedQuestionId);
        }
      }

      function applyPardyQuestionStatus(questionStatus) {
        if (questionStatus == null) return;
        const normalizedStatus = String(questionStatus).toLowerCase();
        state.pardyQuestionStatus = normalizedStatus;
        console.log(LOG, "PARDY question status", normalizedStatus);
        if (normalizedStatus !== "ask") return;
        const questionId = normalizeQuestionId(state.pardyCurrentQuestionId);
        if (!questionId) { logPardySkip("questionStatus ask received before currentQuestionId"); return; }
        state.pardyAskQuestionId = questionId;
        state.pardyAskReadyAt = Date.now() + Math.max(0, Number(_pardyDelay) || 0);
        state.lastPardySkipReason = null;
        if (state.pardyAskTimerId) clearTimeout(state.pardyAskTimerId);
        if (_running) {
          state.pardyAskTimerId = setTimeout(() => {
            state.pardyAskTimerId = null;
            answerQuestion();
          }, Math.max(0, state.pardyAskReadyAt - Date.now()));
        } else {
          state.pardyAskTimerId = null;
        }
      }

      function getNextUnansweredQuestion() {
        const currentId = state.questionIdList[state.currentQuestionIndex];
        if (currentId) {
          const current = findQuestionById(currentId);
          const id = current?._id || current?.id;
          if (current && id && !state.sentQuestionIds.has(normalizeQuestionId(id))) return current;
        }

        for (const questionId of state.questionIdList) {
          if (!questionId || state.sentQuestionIds.has(normalizeQuestionId(questionId))) continue;
          const match = findQuestionById(questionId);
          if (match) return match;
        }

        return state.questions.find((q) => {
          const id = q?._id || q?.id;
          return id && !state.sentQuestionIds.has(normalizeQuestionId(id));
        }) || null;
      }

      function applyBlueboatStateUpdate(packet) {
        const key = packet?.key;
        const data = packet?.data;
        if (typeof key !== "string") return;

        if (key === "PLAYER_JOINS_STATIC_STATE") {
          const gameOptions = data?.gameOptions || {};
          if (isPardySpecialGameType(gameOptions.specialGameType)) setPardyMode(true, "PLAYER_JOINS_STATIC_STATE");
        }

        if (key === "STATE_UPDATE") {
          const type = data?.type;
          if (type === "GAME_QUESTIONS") {
            setQuestions(data?.value);
            console.log(LOG, "Got game questions", state.questions.length);
          } else if (type === "PARDY_MODE_STATE") {
            setPardyMode(true, "PARDY_MODE_STATE");
            const questionId = readStateUpdateValue(data?.value, "currentQuestionId");
            if (questionId != null) applyPardyQuestionId(questionId);
            const questionStatus = readStateUpdateValue(data?.value, "questionStatus");
            if (questionStatus != null) applyPardyQuestionStatus(questionStatus);
          } else if (type === "PLAYER_QUESTION_LIST") {
            state.questionIdList = data?.value?.questionList || [];
            if (Number.isInteger(data?.value?.questionIndex)) setCurrentQuestionIndex(data.value.questionIndex);
            resetAnsweredCache();
          } else if (type === "PLAYER_QUESTION_LIST_INDEX") {
            if (Number.isInteger(data?.value)) setCurrentQuestionIndex(data.value);
          }
        } else if (key === "PLAYER_QUESTION_LIST" && data?.questionList) {
          state.questionIdList = data.questionList;
          if (Number.isInteger(data?.questionIndex)) setCurrentQuestionIndex(data.questionIndex);
          resetAnsweredCache();
        } else if (key === "PLAYER_QUESTION_LIST_INDEX" && Number.isInteger(data)) {
          setCurrentQuestionIndex(data);
        } else if (key === "GAME_QUESTIONS" && Array.isArray(data)) {
          setQuestions(data);
        } else if (key === "QUESTION_REVEALED" && data) {
          const question = data?.question || data;
          const questionId = question?._id || question?.id;
          if (questionId && !findQuestionById(questionId)) {
            state.questions.push(question);
            state.questionById.set(questionId, question);
            state.questionById.set(String(questionId), question);
          }
        }
      }

      function extractBlueboatStateCandidates(payload) {
        const candidates = [];
        for (const item of asArray(payload)) {
          if (!item || typeof item !== "object") continue;
          if (typeof item.key === "string") candidates.push(item);
          if (item.data && typeof item.data === "object" && typeof item.data.key === "string") candidates.push(item.data);
          if (Array.isArray(item.events)) {
            for (const eventItem of item.events) {
              if (eventItem && typeof eventItem === "object" && typeof eventItem.key === "string") candidates.push(eventItem);
            }
          }
        }
        return candidates;
      }

      function answerQuestion() {
        if (!_running) return;
        if (socketManager.transportType === "colyseus") {
          if (state.currentQuestionId == null || state.answerDeviceId == null) return;
          const question = findQuestionById(state.currentQuestionId);
          if (!question) return;
          const packet = { key: "answered", deviceId: state.answerDeviceId, data: {} };
          packet.data.answer = parseQuestionAnswer(question);
          if (!packet.data.answer) return;
          socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
          console.log(LOG, "Answered colyseus", state.currentQuestionId);
        } else {
          let question;
          let rawQuestionId;
          let questionId;

          if (state.isPardyMode) {
            questionId = normalizeQuestionId(state.pardyCurrentQuestionId);
            if (!questionId) { logPardySkip("no PARDY currentQuestionId STATE_UPDATE yet"); return; }
            if (state.pardyQuestionStatus !== "ask" || state.pardyAskQuestionId !== questionId) { logPardySkip("waiting for PARDY questionStatus ask"); return; }
            if (Date.now() < state.pardyAskReadyAt) { logPardySkip("waiting for PARDY answer delay"); return; }
            if (state.sentQuestionIds.has(questionId) || state.lastPardyAnsweredQuestionId === questionId) return;
            question = findQuestionById(questionId);
            if (!question) { logPardySkip(`question ${questionId} is not loaded yet`); return; }
            rawQuestionId = question?._id || question?.id || state.pardyCurrentQuestionId;
          } else {
            question = getNextUnansweredQuestion();
            if (!question) return;
            rawQuestionId = question?._id || question?.id;
            questionId = normalizeQuestionId(rawQuestionId);
            if (!questionId || state.sentQuestionIds.has(normalizeQuestionId(questionId))) return;
          }

          const answer = parseQuestionAnswer(question);
          if (!answer) {
            if (state.isPardyMode) logPardySkip(`no answer found for question ${questionId}`);
            return;
          }
          socketManager.sendMessage("QUESTION_ANSWERED", { questionId: rawQuestionId ?? questionId, answer });
          state.sentQuestionIds.add(questionId);
          if (state.isPardyMode) state.lastPardyAnsweredQuestionId = questionId;
          state.lastPardySkipReason = null;
          console.log(LOG, state.isPardyMode ? "Answered PARDY blueboat" : "Answered blueboat", questionId);
        }
      }

      socketManager.addEventListener("deviceChanges", (event) => {
        for (const { id, data } of event.detail || []) {
          for (const key in data || {}) {
            if (key === "GLOBAL_questions") {
              try { setQuestions(JSON.parse(data[key])); } catch (_) { setQuestions(data[key]); }
              state.answerDeviceId = id;
              console.log(LOG, "Got questions", state.questions.length);
            }
            if (socketManager.playerId && key === `PLAYER_${socketManager.playerId}_currentQuestionId`) {
              state.currentQuestionId = data[key];
            }
          }
        }
      });

      socketManager.addEventListener("blueboatMessage", (event) => {
        if (event.detail?.eventName === "blueboat_SEND_MESSAGE" && event.detail?.payload?.room) {
          socketManager.blueboatRoomId = event.detail.payload.room;
        }
        const candidates = extractBlueboatStateCandidates(event.detail?.payload);
        for (const candidate of candidates) applyBlueboatStateUpdate(candidate);
      });

      // Expose start/stop so the AnRRgm module toggle controls the interval
      let _timerId = null;
      let _running = false;
      let _baseSpeed = 1000;
      let _pardyDelay = 1500;
      const BLUEBOAT_EXTRA_DELAY_MS = 500;

      function getCurrentDelay() {
        if (socketManager.transportType === "blueboat") return _baseSpeed + BLUEBOAT_EXTRA_DELAY_MS;
        return _baseSpeed;
      }

      function scheduleNextTick() {
        if (!_running) return;
        const delay = Math.max(200, Number(getCurrentDelay()) || 1000);
        _timerId = setTimeout(() => {
          answerQuestion();
          scheduleNextTick();
        }, delay);
      }

      function startAutoAnswer(speed = 1000, source = "module toggle", options = {}) {
        const cfg = window.__anrrgmAutoAnswerConfig || {};
        _baseSpeed = Math.max(200, Number(speed ?? cfg.speed) || 1000);
        const pardyDelayNumber = Number(options?.pardyDelay ?? cfg.triviaDelay);
        _pardyDelay = Math.max(0, Math.min(8000, Number.isFinite(pardyDelayNumber) ? pardyDelayNumber : _pardyDelay));
        const wasRunning = _running;
        _running = true;
        if (_timerId) clearTimeout(_timerId);
        scheduleNextTick();
        console.log(LOG, wasRunning ? "Auto-answer timer refreshed by" : "Auto-answer started by", source);
      }

      window.__anrrgmAutoAnswer = {
        start(speed = 1000, options = {}) {
          startAutoAnswer(speed, "module toggle", options);
        },
        stop() {
          _running = false;
          if (_timerId) { clearTimeout(_timerId); _timerId = null; }
          if (state.pardyAskTimerId) { clearTimeout(state.pardyAskTimerId); state.pardyAskTimerId = null; }
        },
      };
      console.log(LOG, "Page context ready, waiting for module toggle.");
    }

    const el = document.createElement("script");
    el.textContent = `;(${pageMain.toString()})();`;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  })();

  (function injectEspPageContextBridge() {
    function pageMain() {
      const LOG = "[ESP][page]";
      const shared = {
        ready: false,
        lastUpdate: 0,
        localPlayerId: null,
        localTeamId: null,
        camera: null,
        players: [],
      };
      const UPDATE_INTERVAL_MS = 50;
      let lastProcessedAt = 0;
      window.__anrrgmEspShared = shared;

      function tick() {
        const now = performance.now();
        if (now - lastProcessedAt < UPDATE_INTERVAL_MS) {
          requestAnimationFrame(tick);
          return;
        }
        lastProcessedAt = now;
        const serializer = window?.serializer;
        const characters = serializer?.state?.characters?.$items;
        const camera = window?.stores?.phaser?.scene?.cameras?.cameras?.[0];
        const localPlayerId = window?.socketManager?.playerId ?? null;
        const localCharacter = localPlayerId != null ? characters?.get?.(localPlayerId) : null;
        const localTeamId = localCharacter?.teamId ?? null;

        if (!characters || typeof characters[Symbol.iterator] !== "function" || !camera || localPlayerId == null || localTeamId == null) {
          shared.ready = false;
          shared.lastUpdate = Date.now();
          requestAnimationFrame(tick);
          return;
        }

        const outPlayers = [];
        for (const [id, character] of characters) {
          const x = Number(character?.x);
          const y = Number(character?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          outPlayers.push({
            id: String(id ?? character?.id ?? "unknown"),
            name: String(character?.name ?? character?.displayName ?? character?.username ?? id ?? "Unknown"),
            teamId: character?.teamId ?? null,
            x,
            y,
          });
        }

        shared.ready = true;
        shared.lastUpdate = Date.now();
        shared.localPlayerId = localPlayerId;
        shared.localTeamId = localTeamId;
        shared.camera = {
          midX: Number(camera?.midPoint?.x ?? 0),
          midY: Number(camera?.midPoint?.y ?? 0),
          zoom: Number(camera?.zoom ?? 1),
        };
        shared.players = outPlayers;
        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
      console.log(LOG, "Bridge ready");
    }

    const el = document.createElement("script");
    el.textContent = `;(${pageMain.toString()})();`;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  })();

  function readUserscriptVersion() {
    
    const CLIENT_VERSION = "3.2.1";
    return CLIENT_VERSION;
  }

  const CONFIG = {
    toggleKey: "\\",
    defaultToggleKey: "\\",
    title: "AnRRgm",
    subtitle: "Client",
    version: readUserscriptVersion(),
    logoUrl: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2296%22%20height%3D%2296%22%20viewBox%3D%220%200%2096%2096%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23ff4747%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23922d57%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2223%22%20fill%3D%22%2317171d%22%2F%3E%3Crect%20x%3D%224%22%20y%3D%224%22%20width%3D%2288%22%20height%3D%2288%22%20rx%3D%2219%22%20fill%3D%22url%28%23g%29%22%2F%3E%3Cpath%20d%3D%22M14%2067%2029%2028h10l15%2039H43l-3-9H27l-3%209zm16-18h7l-3.5-11z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M56%2028h13c12%200%2018%205%2018%2014%200%206-3%2010-8%2012l10%2013H77L66%2053v14H56zm10%209v8h4c5%200%207-1%207-4s-2-4-7-4z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E",
  };

  // --- Core Utilities & Networking (Extracted from Gimkit Cheat) ---

  const colyseusProtocol = {
    HANDSHAKE: 9,
    JOIN_ROOM: 10,
    ERROR: 11,
    LEAVE_ROOM: 12,
    ROOM_DATA: 13,
    ROOM_STATE: 14,
    ROOM_STATE_PATCH: 15,
    ROOM_DATA_SCHEMA: 16,
    ROOM_DATA_BYTES: 17,
  };
  const colyseusProtocolCodeSet = new Set(Object.values(colyseusProtocol));

  function utf8Read(view, offset) {
    const length = view[offset++];
    let string = "";
    for (let i = offset, end = offset + length; i < end; i++) {
      const byte = view[i];
      if ((byte & 0x80) === 0x00) {
        string += String.fromCharCode(byte);
      } else if ((byte & 0xe0) === 0xc0) {
        string += String.fromCharCode(((byte & 0x1f) << 6) | (view[++i] & 0x3f));
      } else if ((byte & 0xf0) === 0xe0) {
        string += String.fromCharCode(((byte & 0x0f) << 12) | ((view[++i] & 0x3f) << 6) | ((view[++i] & 0x3f) << 0));
      }
    }
    return string;
  }

  function parseChangePacket(packet) {
    const out = [];
    for (const change of packet?.changes || []) {
      const data = {};
      const keys = change[1].map((index) => packet.values[index]);
      for (let i = 0; i < keys.length; i++) data[keys[i]] = change[2][i];
      out.push({ id: change[0], data });
    }
    return out;
  }

  function msgpackEncode(value) {
    const bytes = [];
    const deferred = [];
    const write = (input) => {
      const type = typeof input;
      if (type === "string") {
        let len = 0;
        for (let i = 0; i < input.length; i++) {
          const code = input.charCodeAt(i);
          if (code < 128) len++;
          else if (code < 2048) len += 2;
          else if (code < 55296 || code > 57343) len += 3;
          else {
            i++;
            len += 4;
          }
        }
        if (len < 32) bytes.push(160 | len);
        else if (len < 256) bytes.push(217, len);
        else if (len < 65536) bytes.push(218, len >> 8, len & 255);
        else bytes.push(219, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        deferred.push({ type: "string", value: input, offset: bytes.length });
        bytes.length += len;
        return;
      }
      if (type === "number") {
        if (Number.isInteger(input) && Number.isFinite(input)) {
          if (input >= 0) {
            if (input < 128) bytes.push(input);
            else if (input < 256) bytes.push(204, input);
            else if (input < 65536) bytes.push(205, input >> 8, input & 255);
            else if (input < 4294967296) bytes.push(206, input >> 24, (input >> 16) & 255, (input >> 8) & 255, input & 255);
            else {
              const hi = Math.floor(input / Math.pow(2, 32));
              const lo = input >>> 0;
              bytes.push(207, hi >> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255);
            }
          } else if (input >= -32) bytes.push(input);
          else if (input >= -128) bytes.push(208, input & 255);
          else if (input >= -32768) bytes.push(209, (input >> 8) & 255, input & 255);
          else if (input >= -2147483648) bytes.push(210, (input >> 24) & 255, (input >> 16) & 255, (input >> 8) & 255, input & 255);
          else {
            const hi = Math.floor(input / Math.pow(2, 32));
            const lo = input >>> 0;
            bytes.push(211, hi >> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255);
          }
          return;
        }
        bytes.push(203);
        deferred.push({ type: "float64", value: input, offset: bytes.length });
        bytes.length += 8;
        return;
      }
      if (type === "boolean") {
        bytes.push(input ? 195 : 194);
        return;
      }
      if (input == null) {
        bytes.push(192);
        return;
      }
      if (Array.isArray(input)) {
        const len = input.length;
        if (len < 16) bytes.push(144 | len);
        else if (len < 65536) bytes.push(220, len >> 8, len & 255);
        else bytes.push(221, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
        for (const item of input) write(item);
        return;
      }
      const keys = Object.keys(input).filter((k) => typeof input[k] !== "function");
      const len = keys.length;
      if (len < 16) bytes.push(128 | len);
      else if (len < 65536) bytes.push(222, len >> 8, len & 255);
      else bytes.push(223, len >> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255);
      for (const key of keys) {
        write(key);
        write(input[key]);
      }
    };

    write(value);
    const view = new DataView(new ArrayBuffer(bytes.length));
    for (let i = 0; i < bytes.length; i++) view.setUint8(i, bytes[i] & 255);

    for (const part of deferred) {
      if (part.type === "float64") {
        view.setFloat64(part.offset, part.value);
        continue;
      }
      let offset = part.offset;
      const value = part.value;
      for (let i = 0; i < value.length; i++) {
        let code = value.charCodeAt(i);
        if (code < 128) view.setUint8(offset++, code);
        else if (code < 2048) {
          view.setUint8(offset++, 192 | (code >> 6));
          view.setUint8(offset++, 128 | (code & 63));
        } else if (code < 55296 || code > 57343) {
          view.setUint8(offset++, 224 | (code >> 12));
          view.setUint8(offset++, 128 | ((code >> 6) & 63));
          view.setUint8(offset++, 128 | (code & 63));
        } else {
          i++;
          code = 65536 + (((code & 1023) << 10) | (value.charCodeAt(i) & 1023));
          view.setUint8(offset++, 240 | (code >> 18));
          view.setUint8(offset++, 128 | ((code >> 12) & 63));
          view.setUint8(offset++, 128 | ((code >> 6) & 63));
          view.setUint8(offset++, 128 | (code & 63));
        }
      }
    }
    return view.buffer;
  }

  function msgpackDecode(buffer, startOffset = 0) {
    const view = new DataView(buffer);
    let offset = startOffset;

    const readString = (len) => {
      let out = "";
      const end = offset + len;
      while (offset < end) {
        const byte = view.getUint8(offset++);
        if ((byte & 0x80) === 0) out += String.fromCharCode(byte);
        else if ((byte & 0xe0) === 0xc0) out += String.fromCharCode(((byte & 0x1f) << 6) | (view.getUint8(offset++) & 0x3f));
        else if ((byte & 0xf0) === 0xe0) out += String.fromCharCode(((byte & 0x0f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f));
        else {
          const codePoint = ((byte & 0x07) << 18) | ((view.getUint8(offset++) & 0x3f) << 12) | ((view.getUint8(offset++) & 0x3f) << 6) | (view.getUint8(offset++) & 0x3f);
          const cp = codePoint - 0x10000;
          out += String.fromCharCode((cp >> 10) + 0xd800, (cp & 1023) + 0xdc00);
        }
      }
      return out;
    };

    const read = () => {
      const token = view.getUint8(offset++);
      if (token < 0x80) return token;
      if (token < 0x90) {
        const size = token & 0x0f;
        const map = {};
        for (let i = 0; i < size; i++) map[read()] = read();
        return map;
      }
      if (token < 0xa0) {
        const size = token & 0x0f;
        const arr = new Array(size);
        for (let i = 0; i < size; i++) arr[i] = read();
        return arr;
      }
      if (token < 0xc0) return readString(token & 0x1f);
      if (token > 0xdf) return token - 256;
      switch (token) {
        case 192: return null;
        case 194: return false;
        case 195: return true;
        case 196: { const n = view.getUint8(offset); offset += 1; const b = buffer.slice(offset, offset + n); offset += n; return b; }
        case 197: { const n = view.getUint16(offset); offset += 2; const b = buffer.slice(offset, offset + n); offset += n; return b; }
        case 198: { const n = view.getUint32(offset); offset += 4; const b = buffer.slice(offset, offset + n); offset += n; return b; }
        case 202: { const v = view.getFloat32(offset); offset += 4; return v; }
        case 203: { const v = view.getFloat64(offset); offset += 8; return v; }
        case 204: { const v = view.getUint8(offset); offset += 1; return v; }
        case 205: { const v = view.getUint16(offset); offset += 2; return v; }
        case 206: { const v = view.getUint32(offset); offset += 4; return v; }
        case 207: { const hi = view.getUint32(offset); const lo = view.getUint32(offset + 4); offset += 8; return (hi * Math.pow(2, 32)) + lo; }
        case 208: { const v = view.getInt8(offset); offset += 1; return v; }
        case 209: { const v = view.getInt16(offset); offset += 2; return v; }
        case 210: { const v = view.getInt32(offset); offset += 4; return v; }
        case 211: { const hi = view.getInt32(offset); const lo = view.getUint32(offset + 4); offset += 8; return (hi * Math.pow(2, 32)) + lo; }
        case 217: { const n = view.getUint8(offset); offset += 1; return readString(n); }
        case 218: { const n = view.getUint16(offset); offset += 2; return readString(n); }
        case 219: { const n = view.getUint32(offset); offset += 4; return readString(n); }
        case 220: { const n = view.getUint16(offset); offset += 2; const arr = []; for (let i = 0; i < n; i++) arr.push(read()); return arr; }
        case 221: { const n = view.getUint32(offset); offset += 4; const arr = []; for (let i = 0; i < n; i++) arr.push(read()); return arr; }
        case 222: { const n = view.getUint16(offset); offset += 2; const map = {}; for (let i = 0; i < n; i++) map[read()] = read(); return map; }
        case 223: { const n = view.getUint32(offset); offset += 4; const map = {}; for (let i = 0; i < n; i++) map[read()] = read(); return map; }
        default: return null;
      }
    };

    return { value: read(), offset };
  }

  // Simplified msgpack-like encoding/decoding for Blueboat
  const blueboat = (() => {
    function encode(t, e, s) {
      let o = Array.isArray(t) ? { type: 2, data: t, options: { compress: !0 }, nsp: "/" } : { type: 2, data: ["blueboat_SEND_MESSAGE", { room: s, key: t, data: e }], options: { compress: !0 }, nsp: "/" };
      return (function(t) {
        let e = [], i = [], s = function t(e, n, i) {
          let s = typeof i, o = 0, r = 0, a = 0, c = 0, l = 0, u = 0;
          if ("string" === s) {
            l = (function(t) {
              let e = 0, n = 0, i = 0, s = t.length;
              for (i = 0; i < s; i++) (e = t.charCodeAt(i)) < 128 ? n += 1 : e < 2048 ? n += 2 : e < 55296 || 57344 <= e ? n += 3 : (i++, n += 4);
              return n;
            })(i);
            if (l < 32) e.push(160 | l), u = 1;
            else if (l < 256) e.push(217, l), u = 2;
            else if (l < 65536) e.push(218, l >> 8, l), u = 3;
            else e.push(219, l >> 24, l >> 16, l >> 8, l), u = 5;
            return n.push({ h: i, u: l, t: e.length }), u + l;
          }
          if ("number" === s) {
            if (Math.floor(i) === i && isFinite(i)) {
              if (i >= 0) {
                if (i < 128) return e.push(i), 1;
                if (i < 256) return e.push(204, i), 2;
                if (i < 65536) return e.push(205, i >> 8, i), 3;
                if (i < 4294967296) return e.push(206, i >> 24, i >> 16, i >> 8, i), 5;
                a = i / Math.pow(2, 32) >> 0; c = i >>> 0; e.push(207, a >> 24, a >> 16, a >> 8, a, c >> 24, c >> 16, c >> 8, c); return 9;
              } else {
                if (i >= -32) return e.push(i), 1;
                if (i >= -128) return e.push(208, i), 2;
                if (i >= -32768) return e.push(209, i >> 8, i), 3;
                if (i >= -2147483648) return e.push(210, i >> 24, i >> 16, i >> 8, i), 5;
                a = Math.floor(i / Math.pow(2, 32)); c = i >>> 0; e.push(211, a >> 24, a >> 16, a >> 8, a, c >> 24, c >> 16, c >> 8, c); return 9;
              }
            } else {
              e.push(203); n.push({ o: i, u: 8, t: e.length }); return 9;
            }
          }
          if ("object" === s) {
            if (null === i) return e.push(192), 1;
            if (Array.isArray(i)) {
              l = i.length;
              if (l < 16) e.push(144 | l), u = 1;
              else if (l < 65536) e.push(220, l >> 8, l), u = 3;
              else e.push(221, l >> 24, l >> 16, l >> 8, l), u = 5;
              for (o = 0; o < l; o++) u += t(e, n, i[o]);
              return u;
            }
            let d = [], f = "", p = Object.keys(i);
            for (o = 0, r = p.length; o < r; o++) "function" != typeof i[f = p[o]] && d.push(f);
            l = d.length;
            if (l < 16) e.push(128 | l), u = 1;
            else if (l < 65536) e.push(222, l >> 8, l), u = 3;
            else e.push(223, l >> 24, l >> 16, l >> 8, l), u = 5;
            for (o = 0; o < l; o++) u += t(e, n, f = d[o]), u += t(e, n, i[f]);
            return u;
          }
          if ("boolean" === s) return e.push(i ? 195 : 194), 1;
          return 0;
        }(e, i, t);
        let o = new ArrayBuffer(s), r = new DataView(o), a = 0, c = 0, l = -1;
        if (i.length > 0) l = i[0].t;
        for (let u, h = 0, d = 0, f = 0, p = e.length; f < p; f++) {
          r.setUint8(c + f, e[f]);
          if (f + 1 === l) {
            u = i[a]; h = u.u; d = c + l;
            if (u.l) { let g = new Uint8Array(u.l); for (let E = 0; E < h; E++) r.setUint8(d + E, g[E]); }
            else if (u.h) { (function(t, e, n) { for (let i = 0, s = 0, o = n.length; s < o; s++) (i = n.charCodeAt(s)) < 128 ? t.setUint8(e++, i) : (i < 2048 ? t.setUint8(e++, 192 | i >> 6) : (i < 55296 || 57344 <= i ? t.setUint8(e++, 224 | i >> 12) : (s++, i = 65536 + ((1023 & i) << 10 | 1023 & n.charCodeAt(s)), t.setUint8(e++, 240 | i >> 18), t.setUint8(e++, 128 | i >> 12 & 63)), t.setUint8(e++, 128 | i >> 6 & 63)), t.setUint8(e++, 128 | 63 & i)); })(r, d, u.h); }
            else if (void 0 !== u.o) r.setFloat64(d, u.o);
            c += h; if (i[++a]) l = i[a].t;
          }
        }
        let y = Array.from(new Uint8Array(o)); y.unshift(4); return new Uint8Array(y).buffer;
      })(o);
    }

    function decode(packet) {
      function e(t) {
        this.t = 0;
        if (t instanceof ArrayBuffer) { this.i = t; this.s = new DataView(this.i); }
        else { if (!ArrayBuffer.isView(t)) return null; this.i = t.buffer; this.s = new DataView(this.i, t.byteOffset, t.byteLength); }
      }
      e.prototype.g = function(t) { let e = new Array(t); for (let n = 0; n < t; n++) e[n] = this.v(); return e; };
      e.prototype.M = function(t) { let e = {}; for (let n = 0; n < t; n++) e[this.v()] = this.v(); return e; };
      e.prototype.h = function(t) {
        let e = (function(t, e, n) {
          let i = "", s = 0, o = e, r = e + n;
          for (; o < r; o++) {
            let a = t.getUint8(o);
            if (0 != (128 & a)) {
              if (192 != (224 & a)) {
                if (224 != (240 & a)) {
                  s = (7 & a) << 18 | (63 & t.getUint8(++o)) << 12 | (63 & t.getUint8(++o)) << 6 | (63 & t.getUint8(++o)) << 0;
                  if (65536 <= s) { s -= 65536; i += String.fromCharCode(55296 + (s >>> 10), 56320 + (1023 & s)); }
                  else i += String.fromCharCode(s);
                } else i += String.fromCharCode((15 & a) << 12 | (63 & t.getUint8(++o)) << 6 | (63 & t.getUint8(++o)) << 0);
              } else i += String.fromCharCode((31 & a) << 6 | 63 & t.getUint8(++o));
            } else i += String.fromCharCode(a);
          }
          return i;
        })(this.s, this.t, t);
        this.t += t; return e;
      };
      e.prototype.l = function(t) { let e = this.i.slice(this.t, this.t + t); this.t += t; return e; };
      e.prototype.v = function() {
        if (!this.s) return null;
        let t, e = this.s.getUint8(this.t++), n = 0, i = 0, s = 0, o = 0;
        if (e < 192) return e < 128 ? e : e < 144 ? this.M(15 & e) : e < 160 ? this.g(15 & e) : this.h(31 & e);
        if (223 < e) return -1 * (255 - e + 1);
        switch (e) {
          case 192: return null;
          case 194: return !1;
          case 195: return !0;
          case 196: n = this.s.getUint8(this.t); this.t += 1; return this.l(n);
          case 197: n = this.s.getUint16(this.t); this.t += 2; return this.l(n);
          case 198: n = this.s.getUint32(this.t); this.t += 4; return this.l(n);
          case 202: t = this.s.getFloat32(this.t); this.t += 4; return t;
          case 203: t = this.s.getFloat64(this.t); this.t += 8; return t;
          case 204: t = this.s.getUint8(this.t); this.t += 1; return t;
          case 205: t = this.s.getUint16(this.t); this.t += 2; return t;
          case 206: t = this.s.getUint32(this.t); this.t += 4; return t;
          case 207: s = this.s.getUint32(this.t) * Math.pow(2, 32); o = this.s.getUint32(this.t + 4); this.t += 8; return s + o;
          case 208: t = this.s.getInt8(this.t); this.t += 1; return t;
          case 209: t = this.s.getInt16(this.t); this.t += 2; return t;
          case 210: t = this.s.getInt32(this.t); this.t += 4; return t;
          case 211: s = this.s.getInt32(this.t) * Math.pow(2, 32); o = this.s.getUint32(this.t + 4); this.t += 8; return s + o;
          case 217: n = this.s.getUint8(this.t); this.t += 1; return this.h(n);
          case 218: n = this.s.getUint16(this.t); this.t += 2; return this.h(n);
          case 219: n = this.s.getUint32(this.t); this.t += 4; return this.h(n);
          case 220: n = this.s.getUint16(this.t); this.t += 2; return this.g(n);
          case 221: n = this.s.getUint32(this.t); this.t += 4; return this.g(n);
          case 222: n = this.s.getUint16(this.t); this.t += 2; return this.M(n);
          case 223: n = this.s.getUint32(this.t); this.t += 4; return this.M(n);
        }
        return null;
      };
      let q = (function(t) { let n = new e(t = t.slice(1)), i = n.v(); if (n.t === t.byteLength) return i; return null; })(packet);
      return q?.data?.[1];
    }
    return { encode, decode };
  })();

  function decodeBlueboatBinaryPacket(packet) {
    if (!(packet instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(packet);
    if (!bytes.byteLength || bytes[0] !== 4) return null;
    const decoded = msgpackDecode(packet.slice(1), 0)?.value;
    if (!decoded || typeof decoded !== "object") return null;
    const data = decoded?.data;
    const eventName = Array.isArray(data) ? data[0] : null;
    const payload = Array.isArray(data) ? data[1] : data;
    return { eventName, payload, raw: decoded };
  }

  class SocketManager extends EventTarget {
    constructor() {
      super();
      this.socket = null;
      this.transportType = "unknown";
      this.blueboatRoomId = null;
      this.playerId = null;
      this.setup();
    }
    setup() {
      const manager = this;
      const shouldTrackSocketUrl = (url) => String(url || "").includes("gimkitconnect.com");
      class NewWebSocket extends WebSocket {
        constructor(url, params) {
          super(url, params);
          if (shouldTrackSocketUrl(url)) manager.registerSocket(this);
        }
        send(data) {
          manager.onSend(data);
          super.send(data);
        }
      }
      const nativeXMLSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function() {
        this.addEventListener("load", () => {
          if (!String(this.responseURL || "").includes("/matchmaker/join")) return;
          try {
            const response = JSON.parse(this.responseText);
            manager.blueboatRoomId = response.roomId;
          } catch (_) {}
        });
        nativeXMLSend.apply(this, arguments);
      };
      window.WebSocket = NewWebSocket;
      globalThis.socketManager = this;
    }
    registerSocket(socket) {
      this.socket = socket;
      const socketUrl = String(socket?.url || "");
      const looksLikeColyseus = socketUrl.includes("gimkitconnect.com") && !socketUrl.includes("/socket.io/");
      this.transportType = looksLikeColyseus ? "colyseus" : "unknown";
      this.addEventListener("colyseusMessage", (e) => {
        if (e.detail.type !== "DEVICES_STATES_CHANGES") return;
        this.dispatchEvent(new CustomEvent("deviceChanges", { detail: parseChangePacket(e.detail.message) }));
      });
      socket.addEventListener("message", (e) => {
        const firstByte = (() => {
          try {
            const bytes = e.data instanceof ArrayBuffer
              ? new Uint8Array(e.data)
              : (ArrayBuffer.isView(e.data) ? new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength) : null);
            return bytes?.[0] ?? null;
          } catch (_) {
            return null;
          }
        })();
        const blueboatDecoded = firstByte === 4
          ? (() => {
              try { return decodeBlueboatBinaryPacket(e.data) || blueboat.decode(e.data) || null; }
              catch (_) { return null; }
            })()
          : null;
        if (blueboatDecoded) {
          if (blueboatDecoded?.payload?.room) this.blueboatRoomId = blueboatDecoded.payload.room;
          if (blueboatDecoded?.payload?.roomId) this.blueboatRoomId = blueboatDecoded.payload.roomId;
          const normalizedBlueboat = blueboatDecoded?.payload && typeof blueboatDecoded.payload === "object"
            ? { ...blueboatDecoded.payload, eventName: blueboatDecoded.eventName, payload: blueboatDecoded.payload, raw: blueboatDecoded.raw }
            : blueboatDecoded;
          this.dispatchEvent(new CustomEvent("blueboatMessage", { detail: normalizedBlueboat }));
        }
        if (this.transportType === "unknown" && firstByte != null) {
          if (colyseusProtocolCodeSet.has(firstByte)) this.transportType = "colyseus";
          else this.transportType = "blueboat";
        }

        let decoded;
        if (this.transportType === "colyseus") {
          decoded = this.decodeColyseus(e);
          if (decoded) {
            this.dispatchEvent(new CustomEvent("colyseusMessage", { detail: decoded }));
            if (decoded.type === "AUTH_ID") {
              this.playerId = decoded.message;
            }
          }
        } else {
          // already emitted above via universal Blueboat decode path
        }
      });
    }
    onSend(data) {
      const safeDecodeBlueboat = (packet) => {
        if (!(packet instanceof ArrayBuffer) && !ArrayBuffer.isView(packet)) return null;
        const bytes = packet instanceof ArrayBuffer ? new Uint8Array(packet) : new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
        if (!bytes.length || bytes[0] !== 4) return null;
        try {
          return blueboat.decode(packet);
        } catch (_) {
          return null;
        }
      };
      if (this.transportType === "blueboat" && !this.blueboatRoomId) {
        const decoded = safeDecodeBlueboat(data);
        if (decoded?.roomId) this.blueboatRoomId = decoded.roomId;
        if (decoded?.room) this.blueboatRoomId = decoded.room;
      }
      const outbound = safeDecodeBlueboat(data);
      if (outbound) {
        this.dispatchEvent(new CustomEvent("blueboatSend", { detail: outbound }));
      }
    }
    sendBlueboatMessage(channel, data) {
      if (!this.socket || !this.blueboatRoomId) return false;
      const encoded = blueboat.encode(channel, data, this.blueboatRoomId);
      this.socket.send(encoded);
      return true;
    }
    sendMessage(channel, data) {
      if (!this.socket) return;
      const socketUrl = String(this.socket?.url || "");
      const inferredTransport = this.transportType !== "unknown"
        ? this.transportType
        : (socketUrl.includes("/socket.io/") ? "blueboat" : "colyseus");
      if (this.transportType === "unknown") this.transportType = inferredTransport;
      let encoded;
      if (inferredTransport === "blueboat") {
        if (!this.blueboatRoomId) return;
        encoded = blueboat.encode(channel, data, this.blueboatRoomId);
        this.socket.send(encoded);
        return;
      }

      const header = new Uint8Array([colyseusProtocol.ROOM_DATA]);
      const channelEncoded = msgpackEncode(channel);
      const packetEncoded = msgpackEncode(data);
      encoded = new Uint8Array(header.length + channelEncoded.byteLength + packetEncoded.byteLength);
      encoded.set(header, 0);
      encoded.set(new Uint8Array(channelEncoded), header.length);
      encoded.set(new Uint8Array(packetEncoded), header.length + channelEncoded.byteLength);
      this.socket.send(encoded);
    }
    decodeColyseus(event) {
      const bytes = new Uint8Array(event.data);
      const code = bytes[0];
      if (code === colyseusProtocol.ROOM_DATA) {
        const first = msgpackDecode(event.data, 1);
        if (!first) return null;
        let message;
        if (bytes.byteLength > first.offset) {
          const second = msgpackDecode(event.data, first.offset);
          message = second?.value;
        }
        return { type: first.value, message };
      }
      return null;
    }
  }

  const socketManager = new SocketManager();

  const DRAWIT_SKIP = new Set(["DRAW_MODE_LD"]);
  const drawItHookedSockets = new WeakSet();
  let drawItHookInstalled = false;

  function bbDecodeDrawItExact(buffer) {
    try {
      const first = new Uint8Array(buffer)[0];
      if (first >= 0x30 && first <= 0x36) return null;
      function BB(buf) {
        this.t = 0;
        this.i = (buf instanceof ArrayBuffer ? buf : buf.buffer).slice(1);
        this.s = new DataView(this.i);
      }
      BB.prototype.str = function(n) {
        let s = "";
        for (let i = this.t, e = this.t + n; i < e; i++) {
          let a = this.s.getUint8(i);
          if (a < 128) s += String.fromCharCode(a);
          else if ((a & 0xe0) === 0xc0) s += String.fromCharCode((a & 0x1f) << 6 | (this.s.getUint8(++i) & 0x3f));
          else if ((a & 0xf0) === 0xe0) s += String.fromCharCode((a & 0x0f) << 12 | (this.s.getUint8(++i) & 0x3f) << 6 | (this.s.getUint8(++i) & 0x3f));
        }
        this.t += n;
        return s;
      };
      BB.prototype.arr = function(n) {
        const a = [];
        for (let i = 0; i < n; i++) a.push(this.p());
        return a;
      };
      BB.prototype.map = function(n) {
        const o = {};
        for (let i = 0; i < n; i++) {
          const k = this.p();
          o[k] = this.p();
        }
        return o;
      };
      BB.prototype.bin = function(n) {
        const v = this.i.slice(this.t, this.t + n);
        this.t += n;
        return v;
      };
      BB.prototype.p = function() {
        if (this.t >= this.s.byteLength) return undefined;
        const b = this.s.getUint8(this.t++);
        if (b < 0x80) return b;
        if (b < 0x90) return this.map(b & 0x0f);
        if (b < 0xa0) return this.arr(b & 0x0f);
        if (b < 0xc0) return this.str(b & 0x1f);
        if (b > 0xdf) return -(0x100 - b);
        switch (b) {
          case 0xc0: return null;
          case 0xc2: return false;
          case 0xc3: return true;
          case 0xc4: { const n = this.s.getUint8(this.t); this.t += 1; return this.bin(n); }
          case 0xca: { const v = this.s.getFloat32(this.t); this.t += 4; return v; }
          case 0xcb: { const v = this.s.getFloat64(this.t); this.t += 8; return v; }
          case 0xcc: { const v = this.s.getUint8(this.t); this.t += 1; return v; }
          case 0xcd: { const v = this.s.getUint16(this.t); this.t += 2; return v; }
          case 0xce: { const v = this.s.getUint32(this.t); this.t += 4; return v; }
          case 0xd0: { const v = this.s.getInt8(this.t); this.t += 1; return v; }
          case 0xd1: { const v = this.s.getInt16(this.t); this.t += 2; return v; }
          case 0xd2: { const v = this.s.getInt32(this.t); this.t += 4; return v; }
          case 0xd9: { const n = this.s.getUint8(this.t); this.t += 1; return this.str(n); }
          case 0xda: { const n = this.s.getUint16(this.t); this.t += 2; return this.str(n); }
          case 0xdc: { const n = this.s.getUint16(this.t); this.t += 2; return this.arr(n); }
          case 0xdd: { const n = this.s.getUint32(this.t); this.t += 4; return this.arr(n); }
          case 0xde: { const n = this.s.getUint16(this.t); this.t += 2; return this.map(n); }
          case 0xdf: { const n = this.s.getUint32(this.t); this.t += 4; return this.map(n); }
          default: return `<0x${b.toString(16)}>`;
        }
      };
      const parsed = new BB(buffer).p();
      if (Array.isArray(parsed?.data)) {
        const inner = parsed.data[1];
        return { key: inner?.key ?? parsed.data[0], data: inner?.data ?? inner };
      }
      return parsed ?? null;
    } catch (_) {
      return null;
    }
  }

  function logAnswerCandidatesDrawItExact(stateUpdateData) {
    const rows = Array.isArray(stateUpdateData) ? stateUpdateData : [stateUpdateData];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (!Array.isArray(row.value)) continue;
      for (const item of row.value) {
        const directKey = item?.key;
        const nestedKey = item?.value?.key;
        const fieldKey = directKey ?? nestedKey;
        const directValue = item?.value;
        const nestedValue = item?.value?.value;
        const fieldValue = typeof nestedValue === "undefined" ? directValue : nestedValue;
        if (!fieldKey) continue;
        if (fieldKey !== "term") continue;
        if (typeof fieldValue !== "string") continue;
        const answer = fieldValue.trim();
        if (!answer) continue;
        applyDrawItAnswerReveal(answer);
        if (answerPopupState.enabled) showAnswerPopup(answer);
      }
    }
  }


  const lavaBuildingHudState = {
    enabled: false,
    container: null,
    balance: 0,
    config: {
      displayTitle: true,
      hudSize: 100,
    },
  };

  function applyUpgradeLevelsFromStateUpdate(stateUpdateData, source = "unknown") {
    const levels = extractUpgradeLevelsFromStateUpdate(stateUpdateData);
    if (!levels) return false;
    upgradeHudLog(`UPGRADE_LEVELS detected via ${source}`, levels);
    updateUpgradeHudLevels(levels);
    return true;
  }

  function hookSocketDrawIt(ws) {
    if (drawItHookedSockets.has(ws)) return;
    drawItHookedSockets.add(ws);
    ws.addEventListener("message", (e) => {
      const decoded = bbDecodeDrawItExact(e.data);
      if (!decoded?.key) return;
      const key = decoded.key;
      if (DRAWIT_SKIP.has(key)) return;
      if (key === "STATE_UPDATE") {
        logAnswerCandidatesDrawItExact(decoded.data);
        const parsedBalance = extractBalanceFromStateUpdate(decoded.data);
        if (parsedBalance != null) {
          updateUpgradeHudBalance(parsedBalance);
          lavaBuildingHudState.balance = parsedBalance;
          if (lavaBuildingHudState.enabled) renderLavaBuildingHud();
        }
        applyUpgradeLevelsFromStateUpdate(decoded.data, "raw-ws-hook");
      }
    });
  }

  function installDrawItAnswerHook() {
    if (drawItHookInstalled) return;
    drawItHookInstalled = true;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (!this.url?.startsWith("ws://localhost")) hookSocketDrawIt(this);
      originalSend.call(this, data);
    };
  }
  installDrawItAnswerHook();

  const autoAnswerState = {
    questions: [],
    answerDeviceId: null,
    currentQuestionId: null,
    questionIdList: [],
    currentQuestionIndex: -1,
  };
  const AUTO_ANSWER_TICK = 1000;
  let autoAnswerEnabled = false;
  let answerInterval = null;

  function answerQuestion() {
    if (socketManager.transportType === "colyseus") {
      if (autoAnswerState.currentQuestionId == null || autoAnswerState.answerDeviceId == null) return;
      const question = autoAnswerState.questions.find((q) => q._id == autoAnswerState.currentQuestionId);
      if (!question) return;
      const packet = { key: "answered", deviceId: autoAnswerState.answerDeviceId, data: {} };
      if (question.type == "text") packet.data.answer = question.answers[0].text;
      else packet.data.answer = question.answers.find((a) => a.correct)?._id;
      if (!packet.data.answer) return;
      socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
    } else {
      const questionId = autoAnswerState.questionIdList[autoAnswerState.currentQuestionIndex];
      const question = autoAnswerState.questions.find((q) => q._id == questionId);
      if (!question) return;
      const answer = question.type == "mc" ? question.answers.find((a) => a.correct)?._id : question.answers[0]?.text;
      if (!answer) return;
      socketManager.sendMessage("QUESTION_ANSWERED", { answer, questionId });
    }
  }

  const autoAnswerModule = new Module("Auto Answer", {
    onEnable: () => {
      console.log("Auto Answer enabled");
      autoAnswerEnabled = true;
    },
    onDisable: () => {
      console.log("Auto Answer disabled");
      autoAnswerEnabled = false;
    },
  });

  const GAME_FINDER_MODULE_NAME = "Game Finder";
  const GAME_FINDER_LOG_PREFIX = "[Game Finder]";
  const GAME_FINDER_BUTTON_SIZE = 50;
  const GAME_FINDER_API_URL = "https://www.gimkit.com/api/matchmaker/find-info-from-code";
  const GAME_FINDER_MIN_DELAY_MS = 0;
  const GAME_FINDER_MAX_DELAY_MS = 500;
  const GAME_FINDER_DEFAULT_DELAY_MS = 25;
  const GAME_FINDER_MIN_CONCURRENCY = 1;
  const GAME_FINDER_MAX_CONCURRENCY = 32;
  const GAME_FINDER_DEFAULT_CONCURRENCY = 12;
  const GAME_FINDER_RETRY_DELAY_MS = 500;
  const GAME_FINDER_PIN_MIN = 100_000;
  const GAME_FINDER_PIN_MAX = 999_999;
  const GAME_FINDER_PIN_SPACE = GAME_FINDER_PIN_MAX - GAME_FINDER_PIN_MIN + 1;
  const GAME_FINDER_STATS_INTERVAL_MS = 1000;
  const GAME_FINDER_RATE_LIMIT_STATUS_CHECK_INTERVAL = 16;
  const GAME_FINDER_RATE_LIMIT_RESULT = Object.freeze({ rateLimited: true });
  const GAME_FINDER_BUTTON_LABEL = "Find Game";
  const GAME_FINDER_BUTTON_ACTIVE_LABEL = "Finding…";
  const gameFinderState = {
    mounted: false,
    scanning: false,
    scanId: 0,
    delayMs: GAME_FINDER_DEFAULT_DELAY_MS,
    concurrency: GAME_FINDER_DEFAULT_CONCURRENCY,
    button: null,
    input: null,
    wrapper: null,
    inputOriginalStyle: null,
    observer: null,
    attachScheduled: false,
    attachTimer: null,
    foundCode: null,
    attemptedPins: null,
    attemptedCount: 0,
    fallbackCursor: 0,
    attempts: 0,
    inFlight: 0,
    startedAt: 0,
    abortController: null,
    workers: [],
    statsTimer: null,
    lastStatsLogAt: 0,
    rateLimited: false,
  };

  function gameFinderWarn(message, extra) {
    if (extra === undefined) console.warn(`${GAME_FINDER_LOG_PREFIX} ${message}`);
    else console.warn(`${GAME_FINDER_LOG_PREFIX} ${message}`, extra);
  }

  function gameFinderDelay(ms) {
    const delay = Number(ms) || 0;
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  function randomGameFinderPin() {
    return GAME_FINDER_PIN_MIN + randomGameFinderOffset(GAME_FINDER_PIN_SPACE);
  }

  function randomGameFinderOffset(maxExclusive) {
    const max = Math.floor(Number(maxExclusive));
    if (!Number.isFinite(max) || max <= 0) return 0;
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues) {
      const bucketSize = Math.floor(0x1_0000_0000 / max) * max;
      const buffer = new Uint32Array(1);
      do {
        cryptoApi.getRandomValues(buffer);
      } while (buffer[0] >= bucketSize);
      return buffer[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  function createGameFinderAttemptedPins() {
    return new Uint8Array(Math.ceil(GAME_FINDER_PIN_SPACE / 8));
  }

  function markGameFinderAttemptedOffset(offset) {
    const bitset = gameFinderState.attemptedPins;
    if (!bitset || offset < 0 || offset >= GAME_FINDER_PIN_SPACE) return false;
    const byteIndex = offset >> 3;
    const bitMask = 1 << (offset & 7);
    if (bitset[byteIndex] & bitMask) return false;
    bitset[byteIndex] |= bitMask;
    gameFinderState.attemptedCount += 1;
    return true;
  }

  function nextGameFinderPin() {
    if (!gameFinderState.attemptedPins || gameFinderState.attemptedCount >= GAME_FINDER_PIN_SPACE) return null;

    const attemptsBeforeFallback = 24;
    for (let i = 0; i < attemptsBeforeFallback; i += 1) {
      const offset = randomGameFinderOffset(GAME_FINDER_PIN_SPACE);
      if (markGameFinderAttemptedOffset(offset)) return GAME_FINDER_PIN_MIN + offset;
    }

    // Late in a scan, random duplicate rejection can become expensive. Walk a
    // randomized cursor through the remaining space instead of spinning.
    for (let i = 0; i < GAME_FINDER_PIN_SPACE; i += 1) {
      const offset = (gameFinderState.fallbackCursor + i) % GAME_FINDER_PIN_SPACE;
      if (markGameFinderAttemptedOffset(offset)) {
        gameFinderState.fallbackCursor = (offset + 1) % GAME_FINDER_PIN_SPACE;
        return GAME_FINDER_PIN_MIN + offset;
      }
    }
    return null;
  }

  function normalizeGameFinderDelay(value) {
    const delay = Number(value);
    if (!Number.isFinite(delay)) return GAME_FINDER_DEFAULT_DELAY_MS;
    const clamped = Math.max(GAME_FINDER_MIN_DELAY_MS, Math.min(GAME_FINDER_MAX_DELAY_MS, delay));
    return clamped <= 1 ? 0 : clamped;
  }

  function normalizeGameFinderConcurrency(value) {
    const concurrency = Number(value);
    if (!Number.isFinite(concurrency)) return GAME_FINDER_DEFAULT_CONCURRENCY;
    return Math.max(GAME_FINDER_MIN_CONCURRENCY, Math.min(GAME_FINDER_MAX_CONCURRENCY, Math.round(concurrency)));
  }

  function syncGameFinderConfig() {
    const cfg = getModuleConfigSafe(GAME_FINDER_MODULE_NAME, {});
    gameFinderState.delayMs = normalizeGameFinderDelay(cfg.delay);
    gameFinderState.concurrency = normalizeGameFinderConcurrency(cfg.concurrency);
    return { delayMs: gameFinderState.delayMs, concurrency: gameFinderState.concurrency };
  }

  function syncGameFinderDelayFromConfig() {
    return syncGameFinderConfig().delayMs;
  }

  function getGameFinderDelay() {
    return syncGameFinderDelayFromConfig();
  }

  function setGameFinderDelay(value) {
    gameFinderState.delayMs = normalizeGameFinderDelay(value);
    return gameFinderState.delayMs;
  }

  function setGameFinderConcurrency(value) {
    gameFinderState.concurrency = normalizeGameFinderConcurrency(value);
    updateGameFinderButton();
    // Existing scans keep their worker count. The new concurrency value is
    // applied the next time Game Finder is started, while the delay slider is
    // still read live by each worker between requests.
    return gameFinderState.concurrency;
  }

  function isVisibleGameFinderInput(input) {
    if (window.HTMLInputElement && !(input instanceof window.HTMLInputElement)) return false;
    const rect = input.getBoundingClientRect();
    const style = window.getComputedStyle(input);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function findGameCodeInput() {
    const selectors = [
      'input[placeholder="Game Code"]',
      'input[placeholder*="Game" i][placeholder*="Code" i]',
      'input[aria-label*="Game" i][aria-label*="Code" i]',
      'input[inputmode="numeric"][pattern="[0-9]*"]',
      'input[type="number"]',
    ];
    for (const selector of selectors) {
      const input = [...document.querySelectorAll(selector)].find(isVisibleGameFinderInput);
      if (input) return input;
    }
    return [...document.querySelectorAll("input")].find((input) => {
      if (!isVisibleGameFinderInput(input)) return false;
      const type = (input.getAttribute("type") || "text").toLowerCase();
      const inputMode = (input.getAttribute("inputmode") || "").toLowerCase();
      return type === "number" || inputMode === "numeric";
    }) || null;
  }

  function setNativeInputValue(input, value) {
    const previousValue = input.value;
    const ownDescriptor = Object.getOwnPropertyDescriptor(input, "value");
    const prototype = window.HTMLInputElement?.prototype || Object.getPrototypeOf(input);
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const setter = prototypeDescriptor?.set || ownDescriptor?.set;

    input.focus?.();
    if (setter) setter.call(input, value);
    else input.value = value;
    input.setAttribute("value", value);

    if (input._valueTracker && typeof input._valueTracker.setValue === "function") {
      input._valueTracker.setValue(previousValue);
    }

    const inputEvent = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
      : new Event("input", { bubbles: true });
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.at(-1) || "0" }));
  }

  async function waitForGameCodeInput(timeoutMs = 2000) {
    const startedAt = Date.now();
    let input = findGameCodeInput();
    while (!input && Date.now() - startedAt < timeoutMs) {
      await gameFinderDelay(100);
      input = findGameCodeInput();
    }
    return input;
  }

  async function enterFoundGameCode(pin) {
    const code = String(pin).padStart(6, "0");
    const input = await waitForGameCodeInput();
    if (!input) {
      gameFinderWarn(`Found code:${code}, but the Game Code input was not found.`);
      return false;
    }
    setNativeInputValue(input, code);
    const entered = input.value === code;
    if (!entered) {
      gameFinderWarn(`Tried to enter code:${code}, but the input value is still ${input.value || "empty"}.`, { input });
      return false;
    }
    return true;
  }

  function getGameFinderStats() {
    const elapsedSeconds = gameFinderState.startedAt ? Math.max(0.001, (Date.now() - gameFinderState.startedAt) / 1000) : 0;
    const requestsPerSecond = elapsedSeconds ? gameFinderState.attempts / elapsedSeconds : 0;
    return {
      attempts: gameFinderState.attempts,
      inFlight: gameFinderState.inFlight,
      requestsPerSecond,
      concurrency: gameFinderState.concurrency,
      foundCode: gameFinderState.foundCode,
    };
  }

  function updateGameFinderButton() {
    const button = gameFinderState.button;
    if (!button) return;
    const stats = getGameFinderStats();
    const activeLabel = `Stop Game Finder. Attempts: ${stats.attempts}; in flight: ${stats.inFlight}; ${stats.requestsPerSecond.toFixed(1)} req/s; threads: ${stats.concurrency}.`;
    button.classList.toggle("anrrgm-game-finder-active", gameFinderState.scanning);
    button.setAttribute("aria-pressed", String(gameFinderState.scanning));
    button.setAttribute("aria-label", gameFinderState.scanning ? activeLabel : "Start Game Finder");
    button.title = gameFinderState.scanning
      ? `${activeLabel}${stats.foundCode ? ` Found: ${stats.foundCode}.` : " Press to stop trying random codes."}`
      : "Press to enable Game Finder and try random codes.";
  }

  function startGameFinderStatsTimer() {
    if (gameFinderState.statsTimer) clearInterval(gameFinderState.statsTimer);
    gameFinderState.statsTimer = setInterval(() => {
      if (!gameFinderState.scanning) return;
      updateGameFinderButton();
      const now = Date.now();
      if (now - gameFinderState.lastStatsLogAt >= 5000) {
        gameFinderState.lastStatsLogAt = now;
        console.debug(`${GAME_FINDER_LOG_PREFIX} scan stats`, getGameFinderStats());
      }
    }, GAME_FINDER_STATS_INTERVAL_MS);
  }

  function clearGameFinderStatsTimer() {
    if (!gameFinderState.statsTimer) return;
    clearInterval(gameFinderState.statsTimer);
    gameFinderState.statsTimer = null;
  }

  function ensureGameFinderStyle() {
    if (document.getElementById("anrrgm-game-finder-style")) return;
    const styleHost = document.head || document.documentElement;
    if (!styleHost) return;
    const style = document.createElement("style");
    style.id = "anrrgm-game-finder-style";
    style.textContent = `
      .anrrgm-game-finder-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        box-sizing: border-box;
      }
      .anrrgm-game-finder-wrap > input {
        flex: 1 1 auto;
        min-width: 0;
      }
      .anrrgm-game-finder-button {
        --anrrgm-game-finder-size: 50px;
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--anrrgm-game-finder-size);
        height: var(--anrrgm-game-finder-size);
        min-width: var(--anrrgm-game-finder-size);
        flex: 0 0 var(--anrrgm-game-finder-size);
        margin-left: 0;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: #08245c;
        color: #fff;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(8, 36, 92, 0.32);
        vertical-align: middle;
      }
      .anrrgm-game-finder-icon {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .anrrgm-game-finder-dice {
        opacity: 1;
        transform: scale(1);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .anrrgm-game-finder-dice-face {
        position: relative;
        width: calc(var(--anrrgm-game-finder-size) * 0.5);
        height: calc(var(--anrrgm-game-finder-size) * 0.5);
        border: calc(var(--anrrgm-game-finder-size) * 0.045) solid currentColor;
        border-radius: calc(var(--anrrgm-game-finder-size) * 0.13);
        box-sizing: border-box;
        background: rgba(255, 255, 255, 0.12);
        box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.12), inset 0 2px 0 rgba(255, 255, 255, 0.14);
        transform: rotate(-8deg);
      }
      .anrrgm-game-finder-dice-pip {
        position: absolute;
        width: calc(var(--anrrgm-game-finder-size) * 0.075);
        height: calc(var(--anrrgm-game-finder-size) * 0.075);
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
        transform: translate(-50%, -50%);
      }
      .anrrgm-game-finder-dice-pip:nth-child(1) { left: 28%; top: 28%; }
      .anrrgm-game-finder-dice-pip:nth-child(2) { left: 72%; top: 28%; }
      .anrrgm-game-finder-dice-pip:nth-child(3) { left: 50%; top: 50%; }
      .anrrgm-game-finder-dice-pip:nth-child(4) { left: 28%; top: 72%; }
      .anrrgm-game-finder-dice-pip:nth-child(5) { left: 72%; top: 72%; }
      .anrrgm-game-finder-loader {
        opacity: 0;
        transform: scale(0.82);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .anrrgm-game-finder-loader-orbit {
        position: relative;
        width: calc(var(--anrrgm-game-finder-size) * 0.58);
        height: calc(var(--anrrgm-game-finder-size) * 0.58);
        animation: anrrgm-game-finder-loader-spin 1.05s linear infinite;
      }
      .anrrgm-game-finder-loader-dot {
        --anrrgm-game-finder-loader-dot-size: calc(var(--anrrgm-game-finder-size) * 0.105);
        --anrrgm-game-finder-loader-radius: calc(var(--anrrgm-game-finder-size) * 0.22);
        position: absolute;
        left: 50%;
        top: 50%;
        width: var(--anrrgm-game-finder-loader-dot-size);
        height: var(--anrrgm-game-finder-loader-dot-size);
        margin: calc(var(--anrrgm-game-finder-loader-dot-size) / -2) 0 0 calc(var(--anrrgm-game-finder-loader-dot-size) / -2);
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 calc(var(--anrrgm-game-finder-size) * 0.12) rgba(255, 255, 255, 0.36);
        opacity: var(--anrrgm-game-finder-loader-opacity, 1);
        transform: rotate(var(--anrrgm-game-finder-loader-angle)) translateY(calc(var(--anrrgm-game-finder-loader-radius) * -1));
      }
      .anrrgm-game-finder-loader-dot:nth-child(1) { --anrrgm-game-finder-loader-angle: 0deg; --anrrgm-game-finder-loader-opacity: 1; }
      .anrrgm-game-finder-loader-dot:nth-child(2) { --anrrgm-game-finder-loader-angle: 60deg; --anrrgm-game-finder-loader-opacity: 0.86; }
      .anrrgm-game-finder-loader-dot:nth-child(3) { --anrrgm-game-finder-loader-angle: 120deg; --anrrgm-game-finder-loader-opacity: 0.72; }
      .anrrgm-game-finder-loader-dot:nth-child(4) { --anrrgm-game-finder-loader-angle: 180deg; --anrrgm-game-finder-loader-opacity: 0.58; }
      .anrrgm-game-finder-loader-dot:nth-child(5) { --anrrgm-game-finder-loader-angle: 240deg; --anrrgm-game-finder-loader-opacity: 0.44; }
      .anrrgm-game-finder-loader-dot:nth-child(6) { --anrrgm-game-finder-loader-angle: 300deg; --anrrgm-game-finder-loader-opacity: 0.3; }
      .anrrgm-game-finder-button:hover { background: #0b327f; }
      .anrrgm-game-finder-button.anrrgm-game-finder-active {
        background: #0f4bb8;
        box-shadow: 0 8px 18px rgba(15, 75, 184, 0.34);
      }
      .anrrgm-game-finder-button.anrrgm-game-finder-active .anrrgm-game-finder-dice {
        opacity: 0;
        transform: scale(0.82);
      }
      .anrrgm-game-finder-button.anrrgm-game-finder-active .anrrgm-game-finder-loader {
        opacity: 1;
        transform: scale(1);
      }
      @keyframes anrrgm-game-finder-loader-spin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .anrrgm-game-finder-dice,
        .anrrgm-game-finder-loader {
          transition: none;
        }
        .anrrgm-game-finder-loader-orbit {
          animation: none;
        }
        .anrrgm-game-finder-button.anrrgm-game-finder-active .anrrgm-game-finder-loader-dot {
          opacity: 1;
        }
      }
    `;
    styleHost.appendChild(style);
  }

  function isGameFinderButtonAttached() {
    const input = gameFinderState.input;
    const button = gameFinderState.button;
    const wrapper = gameFinderState.wrapper;
    return Boolean(
      input?.isConnected
        && button?.isConnected
        && wrapper?.isConnected
        && wrapper.contains(input)
        && wrapper.contains(button)
        && button.previousElementSibling === input
        && isVisibleGameFinderInput(input)
    );
  }

  function scheduleGameFinderAttach(delayMs = 0) {
    if (!gameFinderState.mounted || gameFinderState.attachScheduled) return;
    gameFinderState.attachScheduled = true;

    const run = () => {
      gameFinderState.attachTimer = null;
      gameFinderState.attachScheduled = false;
      if (gameFinderState.mounted) attachGameFinderButton();
    };

    const delay = Math.max(0, Number(delayMs) || 0);
    if (delay > 0 || typeof requestAnimationFrame !== "function") {
      gameFinderState.attachTimer = setTimeout(run, delay || 50);
      return;
    }
    requestAnimationFrame(run);
  }

  function rememberGameFinderInputStyle(input) {
    if (gameFinderState.input === input && gameFinderState.inputOriginalStyle) return;
    gameFinderState.inputOriginalStyle = {
      width: input.style.getPropertyValue("width"),
      widthPriority: input.style.getPropertyPriority("width"),
      flex: input.style.getPropertyValue("flex"),
      flexPriority: input.style.getPropertyPriority("flex"),
      minWidth: input.style.getPropertyValue("min-width"),
      minWidthPriority: input.style.getPropertyPriority("min-width"),
    };
  }

  function restoreGameFinderInputStyle() {
    const input = gameFinderState.input;
    const original = gameFinderState.inputOriginalStyle;
    if (!input || !original) return;
    for (const [property, valueKey, priorityKey] of [
      ["width", "width", "widthPriority"],
      ["flex", "flex", "flexPriority"],
      ["min-width", "minWidth", "minWidthPriority"],
    ]) {
      if (original[valueKey]) input.style.setProperty(property, original[valueKey], original[priorityKey] || "");
      else input.style.removeProperty(property);
    }
    gameFinderState.inputOriginalStyle = null;
  }

  function syncGameFinderButtonSize(button) {
    button.style.setProperty("--anrrgm-game-finder-size", `${GAME_FINDER_BUTTON_SIZE}px`);
  }

  function cleanupGameFinderWrapper() {
    const wrapper = gameFinderState.wrapper;
    const input = gameFinderState.input;
    if (wrapper?.isConnected && input?.isConnected && wrapper.contains(input)) {
      wrapper.parentElement?.insertBefore(input, wrapper);
    }
    restoreGameFinderInputStyle();
    wrapper?.remove?.();
    gameFinderState.wrapper = null;
  }

  function ensureGameFinderWrapper(input) {
    if (gameFinderState.input && gameFinderState.input !== input) cleanupGameFinderWrapper();
    if (gameFinderState.wrapper?.isConnected && gameFinderState.wrapper.contains(input)) return gameFinderState.wrapper;

    const parent = input.parentElement;
    if (!parent) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "anrrgm-game-finder-wrap";
    parent.insertBefore(wrapper, input);
    rememberGameFinderInputStyle(input);
    input.style.setProperty("width", "auto", "important");
    input.style.setProperty("flex", "1 1 auto");
    input.style.setProperty("min-width", "0");
    wrapper.appendChild(input);
    gameFinderState.wrapper = wrapper;
    return wrapper;
  }

  function attachGameFinderButton() {
    if (!gameFinderState.mounted || !document.body) return;
    const input = findGameCodeInput();
    if (!input) return;

    ensureGameFinderStyle();
    const wrapper = ensureGameFinderWrapper(input);
    if (!wrapper) return;
    gameFinderState.input = input;

    let button = gameFinderState.button;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "anrrgm-game-finder-button";
      button.innerHTML = `
        <span class="anrrgm-game-finder-icon anrrgm-game-finder-dice" aria-hidden="true">
          <span class="anrrgm-game-finder-dice-face">
            <span class="anrrgm-game-finder-dice-pip"></span>
            <span class="anrrgm-game-finder-dice-pip"></span>
            <span class="anrrgm-game-finder-dice-pip"></span>
            <span class="anrrgm-game-finder-dice-pip"></span>
            <span class="anrrgm-game-finder-dice-pip"></span>
          </span>
        </span>
        <span class="anrrgm-game-finder-icon anrrgm-game-finder-loader" aria-hidden="true">
          <span class="anrrgm-game-finder-loader-orbit">
            <span class="anrrgm-game-finder-loader-dot"></span>
            <span class="anrrgm-game-finder-loader-dot"></span>
            <span class="anrrgm-game-finder-loader-dot"></span>
            <span class="anrrgm-game-finder-loader-dot"></span>
            <span class="anrrgm-game-finder-loader-dot"></span>
            <span class="anrrgm-game-finder-loader-dot"></span>
          </span>
        </span>
      `;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleGameFinderScan();
      });
      gameFinderState.button = button;
    }

    syncGameFinderButtonSize(button);
    if (button.parentElement !== wrapper || button.previousElementSibling !== input) {
      wrapper.appendChild(button);
    }
    updateGameFinderButton();
  }

  function observeGameFinderInput() {
    if (gameFinderState.observer) return;
    const observerTarget = document.body || document.documentElement;
    if (!observerTarget) {
      document.addEventListener("DOMContentLoaded", () => {
        if (!gameFinderState.mounted) return;
        observeGameFinderInput();
        scheduleGameFinderAttach();
      }, { once: true });
      return;
    }
    gameFinderState.observer = new MutationObserver(() => {
      if (!gameFinderState.mounted || isGameFinderButtonAttached()) return;
      scheduleGameFinderAttach(150);
    });
    gameFinderState.observer.observe(observerTarget, { childList: true, subtree: true });
  }

  async function checkGameFinderPin(pin, signal, checkRateLimitStatus = false) {
    try {
      const response = await fetch(GAME_FINDER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/plain, */*",
        },
        body: JSON.stringify({ code: String(pin) }),
        signal,
      });

      if (checkRateLimitStatus && response.status === 429) return GAME_FINDER_RATE_LIMIT_RESULT;

      const remainingHeader = response.headers.get("x-ratelimit-remaining");
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const remaining = remainingHeader === null ? null : parseInt(remainingHeader, 10);
      const resetTs = resetHeader === null ? null : parseInt(resetHeader, 10);
      if (Number.isFinite(remaining) && Number.isFinite(resetTs) && remaining <= 1 && resetTs > 0) {
        const waitMs = Math.max(0, resetTs * 1000 - Date.now() + 200);
        if (waitMs > 0 && waitMs <= 30_000) {
          gameFinderWarn(`Rate limit header present; worker waiting ${Math.round(waitMs)}ms.`);
          await gameFinderDelay(waitMs);
        }
      }

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      if (!response.ok || data?.code === 404) return null;
      return data;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) return null;
      await gameFinderDelay(GAME_FINDER_RETRY_DELAY_MS);
      return null;
    }
  }

  function handleGameFinderRateLimit(scanId) {
    if (!gameFinderState.scanning || gameFinderState.scanId !== scanId || gameFinderState.rateLimited) return;
    gameFinderState.rateLimited = true;
    gameFinderState.abortController?.abort();
    stopGameFinderScan();
    setTimeout(() => {
      alert("Game Finder was rate limited by Gimkit. Please wait about a minute before turning it on again.");
    }, 0);
  }

  async function runGameFinderWorker(scanId, workerId, signal) {
    while (gameFinderState.scanning && gameFinderState.scanId === scanId && !signal.aborted && !gameFinderState.foundCode) {
      const pin = nextGameFinderPin();
      if (pin === null) {
        gameFinderWarn("All 6-digit game codes were attempted without finding an active game.");
        stopGameFinderScan();
        return;
      }

      gameFinderState.attempts += 1;
      const attemptNumber = gameFinderState.attempts;
      const checkRateLimitStatus = attemptNumber % GAME_FINDER_RATE_LIMIT_STATUS_CHECK_INTERVAL === 0;
      gameFinderState.inFlight += 1;
      updateGameFinderButton();

      let result = null;
      try {
        result = await checkGameFinderPin(pin, signal, checkRateLimitStatus);
      } finally {
        gameFinderState.inFlight = Math.max(0, gameFinderState.inFlight - 1);
      }

      if (result === GAME_FINDER_RATE_LIMIT_RESULT) {
        handleGameFinderRateLimit(scanId);
        return;
      }

      if (gameFinderState.scanning && gameFinderState.scanId === scanId && !signal.aborted && result && !gameFinderState.foundCode) {
        const foundCode = String(pin).padStart(6, "0");
        gameFinderState.foundCode = foundCode;
        gameFinderState.abortController?.abort();
        console.debug(`${GAME_FINDER_LOG_PREFIX} worker ${workerId} found code ${foundCode}`, getGameFinderStats());
        await enterFoundGameCode(foundCode);
        stopGameFinderScan();
        return;
      }

      const delayMs = gameFinderState.delayMs;
      if (delayMs > 0 && gameFinderState.scanning && gameFinderState.scanId === scanId && !signal.aborted) {
        await gameFinderDelay(delayMs);
      } else if (delayMs <= 0) {
        await Promise.resolve();
      }
    }
  }

  async function runGameFinderScanLoop(scanId) {
    const controller = new AbortController();
    gameFinderState.abortController = controller;
    const workerCount = gameFinderState.concurrency;
    gameFinderState.workers = Array.from({ length: workerCount }, (_, index) => (
      runGameFinderWorker(scanId, index + 1, controller.signal)
    ));
    await Promise.allSettled(gameFinderState.workers);
    if (gameFinderState.scanId === scanId) {
      gameFinderState.workers = [];
      gameFinderState.abortController = null;
      if (gameFinderState.scanning) stopGameFinderScan();
      else updateGameFinderButton();
    }
  }

  function startGameFinderScan() {
    if (gameFinderState.scanning) return;
    syncGameFinderConfig();
    gameFinderState.scanning = true;
    gameFinderState.scanId += 1;
    gameFinderState.foundCode = null;
    gameFinderState.rateLimited = false;
    gameFinderState.attemptedPins = createGameFinderAttemptedPins();
    gameFinderState.attemptedCount = 0;
    gameFinderState.fallbackCursor = randomGameFinderOffset(GAME_FINDER_PIN_SPACE);
    gameFinderState.attempts = 0;
    gameFinderState.inFlight = 0;
    gameFinderState.startedAt = Date.now();
    gameFinderState.workers = [];
    gameFinderState.lastStatsLogAt = 0;
    startGameFinderStatsTimer();
    updateGameFinderButton();
    runGameFinderScanLoop(gameFinderState.scanId).catch((error) => {
      gameFinderWarn("Scan workers stopped unexpectedly.", error);
      stopGameFinderScan();
    });
  }

  function stopGameFinderScan() {
    if (!gameFinderState.scanning && !gameFinderState.abortController) return;
    gameFinderState.scanning = false;
    gameFinderState.scanId += 1;
    gameFinderState.abortController?.abort();
    gameFinderState.abortController = null;
    gameFinderState.workers = [];
    gameFinderState.inFlight = 0;
    clearGameFinderStatsTimer();
    updateGameFinderButton();
  }

  function toggleGameFinderScan() {
    if (gameFinderState.scanning) stopGameFinderScan();
    else startGameFinderScan();
  }

  function startGameFinder() {
    gameFinderState.mounted = true;
    syncGameFinderConfig();
    observeGameFinderInput();
    scheduleGameFinderAttach();
  }

  function stopGameFinder() {
    gameFinderState.mounted = false;
    stopGameFinderScan();
    if (gameFinderState.attachTimer) {
      clearTimeout(gameFinderState.attachTimer);
      gameFinderState.attachTimer = null;
    }
    gameFinderState.attachScheduled = false;
    gameFinderState.button?.remove?.();
    gameFinderState.button = null;
    cleanupGameFinderWrapper();
    gameFinderState.input = null;
    gameFinderState.inputOriginalStyle = null;
    gameFinderState.observer?.disconnect?.();
    gameFinderState.observer = null;
  }

  socketManager.addEventListener("deviceChanges", event => {
    for (const { id, data } of event.detail || []) {
      for (const key in data || {}) {
        if (key === "GLOBAL_questions") {
          autoAnswerState.questions = JSON.parse(data[key]);
          autoAnswerState.answerDeviceId = id;
        }
        if (key === `PLAYER_${socketManager.playerId}_currentQuestionId`) {
          autoAnswerState.currentQuestionId = data[key];
        }
      }
    }
  });

  socketManager.addEventListener("blueboatMessage", event => {
    if (event.detail?.key !== "STATE_UPDATE") return;

    switch (event.detail.data.type) {
      case "GAME_QUESTIONS":
        autoAnswerState.questions = event.detail.data.value;
        break;
      case "PLAYER_QUESTION_LIST":
        autoAnswerState.questionIdList = event.detail.data.value.questionList;
        autoAnswerState.currentQuestionIndex = event.detail.data.value.questionIndex;
        break;
      case "PLAYER_QUESTION_LIST_INDEX":
        autoAnswerState.currentQuestionIndex = event.detail.data.value;
        break;
    }
  });

  const extractDrawItAnswerCandidates = (stateUpdateData) => {
    const rows = Array.isArray(stateUpdateData) ? stateUpdateData : [stateUpdateData];
    const answers = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || !Array.isArray(row.value)) continue;
      for (const item of row.value) {
        const directKey = item?.key;
        const nestedKey = item?.value?.key;
        const fieldKey = directKey ?? nestedKey;
        const directValue = item?.value;
        const nestedValue = item?.value?.value;
        const fieldValue = typeof nestedValue === "undefined" ? directValue : nestedValue;
        if (fieldKey !== "term" || typeof fieldValue !== "string") continue;
        const answer = fieldValue.trim();
        if (answer) answers.push(answer);
      }
    }
    return answers;
  };

  socketManager.addEventListener("blueboatMessage", (event) => {
    if (event.detail?.key !== "STATE_UPDATE") return;
    const answers = extractDrawItAnswerCandidates(event.detail.data);
    if (!answers.length) return;
    const latestAnswer = answers[answers.length - 1];
    applyDrawItAnswerReveal(latestAnswer);
    if (answerPopupState.enabled) showAnswerPopup(latestAnswer);
  });

  socketManager.addEventListener("blueboatMessage", (event) => {
    const packet = event.detail;
    const key = packet?.key ?? packet?.payload?.key ?? packet?.data?.key;
    const directType = packet?.type ?? packet?.data?.type ?? packet?.payload?.data?.type ?? null;
    if (key !== "STATE_UPDATE" && directType !== "BALANCE" && directType !== "UPGRADE_LEVELS") return;
    const stateUpdate = packet?.data ?? packet?.payload?.data ?? packet?.payload ?? packet;
    const balance = extractBalanceFromStateUpdate(stateUpdate);
    if (balance != null) {
      updateUpgradeHudBalance(balance);
      lavaBuildingHudState.balance = balance;
      if (lavaBuildingHudState.enabled) renderLavaBuildingHud();
      return;
    }
    const applied = applyUpgradeLevelsFromStateUpdate(stateUpdate, "socketManager");
    if (!applied) {
      upgradeHudLog("STATE_UPDATE received but no UPGRADE_LEVELS found", { packet, stateUpdate });
    }
  });

  answerInterval = setInterval(() => {
    if (!autoAnswerEnabled) return;
    answerQuestion();
  }, AUTO_ANSWER_TICK);

  const ESP_LOG = "[ESP]";
  const espState = {
    enabled: false,
    canvas: null,
    ctx: null,
    stores: null,
    storesPromise: null,
    seenPlayers: new Map(),
    waitLogTick: 0,
  };
  const renderDiagnostics = {
    frameCount: 0,
    droppedFrames: 0,
    lastFrameAt: 0,
    moduleMs: {
      esp: 0,
      crosshair: 0,
      autoAim: 0,
      triggerAssist: 0,
    },
  };
  const unifiedRenderState = {
    rafId: null,
    running: false,
  };
  const cameraZoomState = {
    enabled: false,
    originalZoom: null,
    cameraRef: null,
    baselineByCamera: new WeakMap(),
    toastTimeoutId: null,
    toastEl: null,
    lastToastValue: null,
  };
  const CAMERA_ZOOM_MODULE_NAME = "Zoom (FOV)";
  const CAMERA_ZOOM_MIN = 0.3;
  const CAMERA_ZOOM_MAX = 2.0;
  const CAMERA_ZOOM_STEP = 0.05;
  const CAMERA_ZOOM_DEFAULT = 0.8;

  function espLog(message, extra) {
    if (extra !== undefined) console.log(`${ESP_LOG} ${message}`, extra);
    else console.log(`${ESP_LOG} ${message}`);
  }

  function createEspCanvas() {
    if (espState.canvas?.parentNode) {
      espLog("Canvas already exists; reusing existing canvas.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.position = "fixed";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    canvas.style.zIndex = "9999";
    canvas.style.pointerEvents = "none";
    canvas.style.userSelect = "none";
    document.body.appendChild(canvas);
    espState.canvas = canvas;
    espState.ctx = canvas.getContext("2d");
    if (!espState.ctx) {
      espLog("Failed to get canvas 2D context");
      canvas.remove();
      espState.canvas = null;
      return;
    }
    espLog("Canvas created");
  }

  function destroyEspCanvas() {
    if (!espState.canvas) return;
    espState.canvas.remove();
    espState.canvas = null;
    espState.ctx = null;
    espLog("Canvas destroyed");
  }

  function resizeEspCanvas() {
    if (!espState.canvas?.parentNode) return;
    espState.canvas.width = window.innerWidth;
    espState.canvas.height = window.innerHeight;
    espLog(`Canvas resized to ${espState.canvas.width}x${espState.canvas.height}`);
  }

  function clampCameraZoom(value) {
    return Math.min(CAMERA_ZOOM_MAX, Math.max(CAMERA_ZOOM_MIN, Number(value) || CAMERA_ZOOM_DEFAULT));
  }

  function resolvePrimaryCamera() {
    return window?.stores?.phaser?.scene?.cameras?.cameras?.[0] || null;
  }

  function ensureCameraZoomToast() {
    if (cameraZoomState.toastEl?.isConnected) return cameraZoomState.toastEl;
    const toast = document.createElement("div");
    toast.style.cssText = "position:fixed;left:50%;bottom:36px;transform:translate(-50%,8px);background:rgba(8,12,20,.82);border:1px solid rgba(255,255,255,.22);color:#fff;padding:6px 10px;border-radius:8px;font:600 12px Inter,system-ui,sans-serif;z-index:2147483647;opacity:0;pointer-events:none;transition:opacity .15s ease,transform .15s ease;";
    document.documentElement.appendChild(toast);
    cameraZoomState.toastEl = toast;
    return toast;
  }

  function showCameraZoomToast(zoomValue) {
    const rounded = Math.round(clampCameraZoom(zoomValue) * 100) / 100;
    if (cameraZoomState.lastToastValue === rounded) return;
    cameraZoomState.lastToastValue = rounded;
    const toast = ensureCameraZoomToast();
    toast.textContent = `Zoom: ${rounded.toFixed(2)}x`;
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%,0)";
    if (cameraZoomState.toastTimeoutId) clearTimeout(cameraZoomState.toastTimeoutId);
    cameraZoomState.toastTimeoutId = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%,8px)";
    }, 900);
  }

  function applyCameraZoomTick() {
    const cfgStore = state?.moduleConfig instanceof Map ? state.moduleConfig : null;
    const cfg = (cfgStore?.get(CAMERA_ZOOM_MODULE_NAME) && typeof cfgStore.get(CAMERA_ZOOM_MODULE_NAME) === "object")
      ? cfgStore.get(CAMERA_ZOOM_MODULE_NAME)
      : { zoom: CAMERA_ZOOM_DEFAULT };
    const desiredZoom = clampCameraZoom(cfg.zoom ?? CAMERA_ZOOM_DEFAULT);
    if (Number(cfg.zoom) !== desiredZoom) cfg.zoom = desiredZoom;
    const camera = resolvePrimaryCamera();
    if (!camera) return;
    if (camera !== cameraZoomState.cameraRef) {
      cameraZoomState.cameraRef = camera;
      const baselineZoom = Number(camera?.zoom ?? 1);
      if (Number.isFinite(baselineZoom) && baselineZoom > 0) {
        cameraZoomState.originalZoom = baselineZoom;
        cameraZoomState.baselineByCamera.set(camera, baselineZoom);
      } else {
        cameraZoomState.originalZoom = 1;
      }
    }
    const baselineZoomRaw = cameraZoomState.baselineByCamera.get(camera);
    const baselineZoom = Number.isFinite(baselineZoomRaw) && baselineZoomRaw > 0 ? baselineZoomRaw : Number(camera?.zoom ?? 1) || 1;
    const targetZoom = baselineZoom * desiredZoom;
    const currentZoom = Number(camera?.zoom ?? 1) || 1;
    if (Math.abs(currentZoom - targetZoom) > 1e-4) {
      if (typeof camera?.setZoom === "function") camera.setZoom(targetZoom);
      else camera.zoom = targetZoom;
    }
  }

  function startCameraZoom() {
    if (cameraZoomState.enabled) return;
    cameraZoomState.enabled = true;
    cameraZoomState.cameraRef = null;
    cameraZoomState.originalZoom = null;
    cameraZoomState.lastToastValue = null;
    startUnifiedRenderLoop();
  }

  function hideCameraZoomToast() {
    if (cameraZoomState.toastTimeoutId) {
      clearTimeout(cameraZoomState.toastTimeoutId);
      cameraZoomState.toastTimeoutId = null;
    }
    if (cameraZoomState.toastEl?.isConnected) {
      cameraZoomState.toastEl.style.opacity = "0";
      cameraZoomState.toastEl.style.transform = "translate(-50%,8px)";
    }
  }

  function stopCameraZoom() {
    if (!cameraZoomState.enabled) return;
    cameraZoomState.enabled = false;
    hideCameraZoomToast();
    const camera = resolvePrimaryCamera();
    const restoreZoom = Number(
      camera && cameraZoomState.baselineByCamera.has(camera)
        ? cameraZoomState.baselineByCamera.get(camera)
        : cameraZoomState.originalZoom,
    );
    if (camera === cameraZoomState.cameraRef && Number.isFinite(restoreZoom) && restoreZoom > 0.2 && restoreZoom < 5) {
      const currentZoom = Number(camera.zoom ?? 1) || 1;
      if (Math.abs(currentZoom - restoreZoom) > 1e-4) {
        if (typeof camera?.setZoom === "function") camera.setZoom(restoreZoom);
        else camera.zoom = restoreZoom;
      }
    }
    cameraZoomState.originalZoom = null;
    cameraZoomState.cameraRef = null;
    stopUnifiedRenderLoopIfIdle();
  }

  async function resolveEspStores() {
    if (espState.stores) return espState.stores;
    if (espState.storesPromise) return espState.storesPromise;
    espState.storesPromise = (async () => {
      if (!document.body) {
        await new Promise((resolve) => window.addEventListener("DOMContentLoaded", resolve, { once: true }));
      }
      const moduleScript = document.querySelector("script[src][type='module']");
      if (!moduleScript?.src) throw new Error("Failed to find game module script");

      const response = await fetch(moduleScript.src);
      const text = await response.text();
      const gameScriptUrl = text.match(/FixSpinePlugin-[^.]+\.js/)?.[0];
      if (!gameScriptUrl) throw new Error("Failed to find game script URL");

      // In extension mode this file is loaded from a chrome-extension:// or moz-extension:// URL.
      // Resolve the Gimkit chunk against the page module script so dynamic import does
      // not accidentally target the extension origin.
      const gameScriptHref = new URL(gameScriptUrl, moduleScript.src).href;
      const gameScript = await import(gameScriptHref);
      const stores = Object.values(gameScript).find((value) => value && value.assignment);
      if (!stores) throw new Error("Failed to resolve stores export");

      window.stores = stores;
      espState.stores = stores;
      espLog("Resolved stores via module import");
      return stores;
    })();
    try {
      return await espState.storesPromise;
    } finally {
      espState.storesPromise = null;
    }
  }

  function primeSharedPlayerData() {
    if (espState.stores || espState.storesPromise) return;
    const attemptResolve = () => {
      resolveEspStores().catch((error) => {
        espLog("Shared stores resolve failed; retrying", error);
        setTimeout(() => {
          if (!espState.stores) attemptResolve();
        }, 1500);
      });
    };
    attemptResolve();
  }

  primeSharedPlayerData();

  function getCharacterPosition(character) {
    const x = Number(character?.x ?? character?.position?.x ?? character?.body?.x);
    const y = Number(character?.y ?? character?.position?.y ?? character?.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function getCharacters(stores) {
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;
    if (!map) return [];
    if (typeof map.values === "function") return Array.from(map.values());
    if (Array.isArray(map)) return map;
    return Object.values(map);
  }

  function getCharacterEntries(stores) {
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;
    if (!map) return [];
    if (typeof map.entries === "function") {
      return Array.from(map.entries(), ([id, character]) => ({ id, character }));
    }
    if (Array.isArray(map)) {
      return map.map((character, index) => ({ id: character?.id ?? character?.characterId ?? index, character }));
    }
    return Object.entries(map).map(([id, character]) => ({ id, character }));
  }

  function getMainCharacter(stores) {
    const mainId = stores?.phaser?.mainCharacter?.id;
    const manager = stores?.phaser?.scene?.characterManager;
    const map = manager?.characters;
    if (!map) return null;
    if (mainId != null && typeof map.get === "function") return map.get(mainId) || null;
    return getCharacters(stores).find((character) => character?.id === mainId || character?.characterId === mainId) || null;
  }

  function getCharacterTeam(character) {
    return character?.teamId ?? character?.team?.id ?? character?.state?.teamId ?? character?.data?.teamId ?? null;
  }

  function getCharacterId(character) {
    return character?.id ?? character?.characterId ?? character?.playerId ?? character?.entityId ?? null;
  }

  function getSerializerCharacterById(id) {
    if (id == null) return null;
    const map = window?.serializer?.state?.characters?.$items;
    if (!map || typeof map.get !== "function") return null;
    return map.get(id) || map.get(String(id)) || null;
  }

  function findSerializerCharacterByPosition(character) {
    const map = window?.serializer?.state?.characters?.$items;
    if (!map || typeof map.values !== "function") return null;
    const x = Number(character?.x ?? character?.position?.x);
    const y = Number(character?.y ?? character?.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const candidate of map.values()) {
      const cx = Number(candidate?.x ?? candidate?.position?.x);
      const cy = Number(candidate?.y ?? candidate?.position?.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (Math.abs(cx - x) < 0.5 && Math.abs(cy - y) < 0.5) return candidate;
    }
    return null;
  }

  function getCharacterName(character, fallbackId = null) {
    const id = getCharacterId(character) ?? fallbackId;
    const serializerCharacter = getSerializerCharacterById(id) ?? findSerializerCharacterByPosition(character);
    return character?.name
      ?? character?.nametag?.name
      ?? character?.displayName
      ?? character?.state?.name
      ?? character?.state?.nametag?.name
      ?? character?.username
      ?? character?.playerName
      ?? character?.profile?.name
      ?? character?.meta?.name
      ?? character?.data?.name
      ?? character?.data?.nametag?.name
      ?? serializerCharacter?.name
      ?? serializerCharacter?.nametag?.name
      ?? serializerCharacter?.displayName
      ?? serializerCharacter?.username
      ?? "Player";
  }

  function formatEspLabel(playerName, distance, namesDistanceOnly, style) {
    const safeName = String(playerName || "Player");
    const distanceText = `${Math.floor(Number(distance) || 0)}m`;
    const showName = namesDistanceOnly?.showName !== undefined ? namesDistanceOnly.showName : true;
    const showDistance = namesDistanceOnly?.showDistance !== undefined ? namesDistanceOnly.showDistance : true;
    if (!showName && !showDistance) return "";
    if (showName && !showDistance) return safeName;
    if (!showName && showDistance) return distanceText;
    switch (style) {
      case "dash":
        return `${safeName} - ${distanceText}`;
      case "pipe":
        return `${safeName} | ${distanceText}`;
      case "distanceFirst":
        return `${distanceText} • ${safeName}`;
      case "paren":
        return `${safeName} (${distanceText})`;
      case "dot":
      default:
        return `${safeName} • ${distanceText}`;
    }
  }

  function resolveNameDistanceVisibility(cfg, isTeammate) {
    const nameKey = isTeammate ? "teammateNameTextEnabled" : "nameTextEnabled";
    const distanceKey = isTeammate ? "teammateDistanceTextEnabled" : "distanceTextEnabled";
    const explicitName = cfg?.[nameKey];
    const explicitDistance = cfg?.[distanceKey];
    if (typeof explicitName === "boolean" || typeof explicitDistance === "boolean") {
      return {
        showName: explicitName !== false,
        showDistance: explicitDistance !== false,
      };
    }
    const legacyNamesEnabled = isTeammate ? (cfg?.teammateNames !== false) : (cfg?.names !== false);
    const legacyDistanceOnly = isTeammate ? (cfg?.teammateNamesDistanceOnly === true) : (cfg?.namesDistanceOnly === true);
    if (!legacyNamesEnabled) return { showName: false, showDistance: false };
    if (legacyDistanceOnly) return { showName: false, showDistance: true };
    return { showName: true, showDistance: true };
  }

  function projectWorldToScreen(position, cameraSnapshot, viewportWidth, viewportHeight) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    const camX = Number(cameraSnapshot?.midX);
    const camY = Number(cameraSnapshot?.midY);
    const zoom = Number(cameraSnapshot?.zoom ?? 1) || 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(camX) || !Number.isFinite(camY)) return null;
    return {
      x: (x - camX) * zoom + viewportWidth / 2,
      y: (y - camY) * zoom + viewportHeight / 2,
      zoom,
    };
  }

  function getEspRenderConfig() {
    const defaults = {
      showEnemies: true,
      showTeammates: true,
      hitbox: true,
      hitboxSize: 150,
      hitboxWidth: 3,
      hitboxColor: "#ff4444",
      teammateHitbox: true,
      teammateHitboxSize: 150,
      teammateHitboxWidth: 3,
      teammateHitboxColor: "#36d17c",
      names: true,
      namesDistanceOnly: false,
      nameTextEnabled: true,
      distanceTextEnabled: true,
      nameSize: 22,
      nameColor: "#7a0c0c",
      nameOutline: true,
      nameOutlineColor: "#000000",
      nameOutlineWidth: 1,
      nameDistanceStyle: "dot",
      teammateNames: true,
      teammateNamesDistanceOnly: false,
      teammateNameTextEnabled: true,
      teammateDistanceTextEnabled: true,
      teammateNameSize: 22,
      teammateNameColor: "#baf7d2",
      teammateNameOutline: true,
      teammateNameOutlineColor: "#ffffff",
      teammateNameOutlineWidth: 1,
      teammateNameDistanceStyle: "dot",
      offscreenStyle: "tracers",
      offscreenTheme: "classic",
      alwaysTracer: false,
      tracerWidth: 3,
      tracerColor: "#ff4444",
      teammateOffscreenStyle: "tracers",
      teammateOffscreenTheme: "classic",
      teammateAlwaysTracer: false,
      teammateTracerWidth: 3,
      teammateTracerColor: "#36d17c",
      arrowSize: 14,
      arrowColor: "#ff4444",
      teammateArrowSize: 14,
      teammateArrowColor: "#36d17c",
      arrowStyle: "regular",
      teammateArrowStyle: "regular",
      valueTextColor: window.__anrrgmEspValueTextColor || "#ffffff",
    };
    const liveCfg = window.__anrrgmEspConfig;
    if (liveCfg && typeof liveCfg === "object") return { ...defaults, ...liveCfg };
    return defaults;
  }

  function getHealthBarsConfig() {
    const defaults = {
      enabled: true,
      width: 54,
      height: 6,
      yOffset: 32,
      showText: true,
    };
    const liveCfg = window.__anrrgmHealthBarsConfig;
    return liveCfg && typeof liveCfg === "object" ? { ...defaults, ...liveCfg } : defaults;
  }

  function readNumericCandidate(source, paths) {
    if (!source) return null;
    for (const path of paths) {
      const parts = path.split(".");
      let node = source;
      for (const part of parts) node = node?.[part];
      const value = Number(node);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function getCharacterHealthSnapshot(character, fallbackId = null) {
    const cid = getCharacterId(character) ?? fallbackId;
    const serializerCharacter = getSerializerCharacterById(cid) ?? findSerializerCharacterByPosition(character);
    const candidates = [character, serializerCharacter];
    let current = null;
    let max = null;
    for (const source of candidates) {
      if (!source) continue;
      if (current == null) {
        current = readNumericCandidate(source, ["health", "hp", "currentHealth", "state.health", "stats.health", "data.health"]);
      }
      if (max == null) {
        max = readNumericCandidate(source, ["maxHealth", "maxHp", "healthMax", "state.maxHealth", "stats.maxHealth", "data.maxHealth"]);
      }
      if (current != null && max != null) break;
    }
    if (current == null) return null;
    if (max == null || max <= 0) {
      if (current <= 100) max = 100;
      else return null;
    }
    return { current: Math.max(0, current), max: Math.max(1, max) };
  }

  function renderEspPlayers(stores) {
    const ctx = espState.ctx;
    const canvas = espState.canvas;
    if (!ctx || !canvas) {
      espLog("Missing data: no canvas/context; rendering skip.");
      return;
    }
    const camera = stores?.phaser?.scene?.cameras?.cameras?.[0];
    const me = getMainCharacter(stores);
    if (!camera || !me) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const myTeam = getCharacterTeam(me);
    const espCfg = getEspRenderConfig();
    const healthCfg = getHealthBarsConfig();
    const showHealthBars = state.enabledModules?.has("Health Bars") && healthCfg.enabled !== false;
    const camX = Number(camera?.midPoint?.x);
    const camY = Number(camera?.midPoint?.y);
    const zoom = Number(camera?.zoom ?? 1) || 1;
    if (!Number.isFinite(camX) || !Number.isFinite(camY)) return;

    const activeIds = new Set();
    const now = performance.now();

    for (const entry of getCharacterEntries(stores)) {
      const character = entry.character;
      const characterId = entry.id ?? getCharacterId(character);
      if (!character || character === me) continue;
      const pos = getCharacterPosition(character);
      if (!pos) continue;
      const stableId = String(characterId ?? `${Math.round(pos.x)}:${Math.round(pos.y)}`);
      activeIds.add(stableId);
      const angle = Math.atan2(pos.y - camY, pos.x - camX);
      const worldDistance = Math.hypot(pos.x - camX, pos.y - camY);
      const screenDistance = worldDistance * zoom;
      const rawX = (pos.x - camX) * zoom + canvas.width / 2;
      const rawY = (pos.y - camY) * zoom + canvas.height / 2;
      const prev = espState.seenPlayers.get(stableId);
      let screenX = rawX;
      let screenY = rawY;
      if (prev) {
        const delta = Math.hypot(rawX - prev.x, rawY - prev.y);
        if (delta < 300) {
          const blend = 0.38;
          screenX = prev.x + (rawX - prev.x) * blend;
          screenY = prev.y + (rawY - prev.y) * blend;
        }
      }
      espState.seenPlayers.set(stableId, { x: screenX, y: screenY, t: now });
      const onScreen = screenX >= 0 && screenX <= canvas.width && screenY >= 0 && screenY <= canvas.height;
      const isTeammate = myTeam !== null && getCharacterTeam(character) === myTeam;
      if (isTeammate && espCfg.showTeammates === false) continue;
      if (!isTeammate && espCfg.showEnemies === false) continue;
      const showHitbox = isTeammate ? espCfg.teammateHitbox !== false : espCfg.hitbox !== false;
      const nameDistanceVisibility = resolveNameDistanceVisibility(espCfg, isTeammate);
      const chosenDistanceStyle = isTeammate ? espCfg.teammateNameDistanceStyle : espCfg.nameDistanceStyle;
      const distanceStyle = ["dot", "dash", "pipe", "paren", "distanceFirst"].includes(chosenDistanceStyle)
        ? chosenDistanceStyle
        : "dot";
      const chosenOffscreenStyle = isTeammate ? espCfg.teammateOffscreenStyle : espCfg.offscreenStyle;
      const offscreenStyle = chosenOffscreenStyle === "arrows" || chosenOffscreenStyle === "none"
        ? chosenOffscreenStyle
        : "tracers";
      const offscreenTheme = String(isTeammate ? espCfg.teammateOffscreenTheme : espCfg.offscreenTheme || "classic");
      const alwaysTracer = isTeammate ? espCfg.teammateAlwaysTracer === true : espCfg.alwaysTracer === true;
      const chosenArrowStyle = isTeammate ? espCfg.teammateArrowStyle : espCfg.arrowStyle;
      const arrowStyle = ["regular", "dot", "modern"].includes(chosenArrowStyle) ? chosenArrowStyle : "regular";
      const hitboxColor = isTeammate
        ? (espCfg.teammateHitboxColor || espCfg.hitboxColor || "green")
        : (espCfg.hitboxColor || "red");
      const tracerColor = isTeammate
        ? (espCfg.teammateTracerColor || espCfg.tracerColor || "green")
        : (espCfg.tracerColor || "red");
      const arrowColor = isTeammate
        ? (espCfg.teammateArrowColor || espCfg.arrowColor || "green")
        : (espCfg.arrowColor || "red");
      const nameColor = isTeammate
        ? (espCfg.teammateNameColor || espCfg.nameColor || "#000000")
        : (espCfg.nameColor || "#000000");
      const nameOutlineEnabled = isTeammate ? espCfg.teammateNameOutline !== false : espCfg.nameOutline !== false;
      const nameOutlineColor = isTeammate
        ? (espCfg.teammateNameOutlineColor || espCfg.nameOutlineColor || "#000000")
        : (espCfg.nameOutlineColor || "#000000");
      const hitboxSize = Math.max(12, Number(isTeammate ? espCfg.teammateHitboxSize : espCfg.hitboxSize) || 80);
      const hitboxWidth = Math.max(1, Number(isTeammate ? espCfg.teammateHitboxWidth : espCfg.hitboxWidth) || 3);
      const nameSize = Math.max(8, Number(isTeammate ? espCfg.teammateNameSize : espCfg.nameSize) || 20);
      const nameOutlineWidth = Math.max(1, Number(isTeammate ? espCfg.teammateNameOutlineWidth : espCfg.nameOutlineWidth) || 3);
      const tracerWidth = Math.max(1, Number(isTeammate ? espCfg.teammateTracerWidth : espCfg.tracerWidth) || 3);
      const arrowSize = Math.max(6, Number(isTeammate ? espCfg.teammateArrowSize : espCfg.arrowSize) || 14);

      if (onScreen && showHitbox) {
        const boxSize = Math.max(24, hitboxSize * zoom);
        ctx.beginPath();
        ctx.lineWidth = hitboxWidth;
        ctx.strokeStyle = hitboxColor;
        ctx.strokeRect(screenX - boxSize / 2, screenY - boxSize / 2, boxSize, boxSize);
      }

      const shouldDrawOffscreen = !onScreen && offscreenStyle !== "none";
      const shouldDrawTracer = offscreenStyle === "tracers" && (alwaysTracer || !onScreen);

      let labelX = onScreen ? screenX : Math.cos(angle) * Math.min(250, screenDistance) + canvas.width / 2;
      let labelY = onScreen ? (screenY - 18) : Math.sin(angle) * Math.min(250, screenDistance) + canvas.height / 2;

      if (shouldDrawOffscreen || shouldDrawTracer) {
        const margin = 20;
        const halfW = canvas.width / 2 - margin;
        const halfH = canvas.height / 2 - margin;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const scale = Math.min(
          Math.abs(halfW / (dx || 0.0001)),
          Math.abs(halfH / (dy || 0.0001))
        );
        const endX = canvas.width / 2 + dx * scale;
        const endY = canvas.height / 2 + dy * scale;

        if (shouldDrawTracer) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(canvas.width / 2, canvas.height / 2);
          ctx.lineTo(onScreen ? screenX : endX, onScreen ? screenY : endY);
          ctx.lineWidth = tracerWidth;
          ctx.strokeStyle = tracerColor;
          if (offscreenTheme === "dashed") ctx.setLineDash([8, 6]);
          if (offscreenTheme === "neon") {
            ctx.shadowColor = tracerColor;
            ctx.shadowBlur = 10;
          }
          ctx.stroke();
          ctx.restore();
        } else if (offscreenStyle === "arrows" && !onScreen) {
          const headLength = arrowSize;
          const headAngle = Math.PI / 6;
          const a1 = angle - headAngle;
          const a2 = angle + headAngle;
          ctx.save();
          ctx.beginPath();
          if (arrowStyle === "dot") {
            ctx.arc(endX, endY, Math.max(4, headLength * 0.35), 0, Math.PI * 2);
            ctx.fillStyle = arrowColor;
          } else if (arrowStyle === "modern") {
            const tailX = endX - Math.cos(angle) * headLength;
            const tailY = endY - Math.sin(angle) * headLength;
            const perpX = Math.cos(angle + Math.PI / 2) * (headLength * 0.45);
            const perpY = Math.sin(angle + Math.PI / 2) * (headLength * 0.45);
            ctx.moveTo(endX, endY);
            ctx.quadraticCurveTo(tailX + perpX, tailY + perpY, tailX, tailY);
            ctx.quadraticCurveTo(tailX - perpX, tailY - perpY, endX, endY);
            ctx.fillStyle = arrowColor;
          } else {
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - Math.cos(a1) * headLength, endY - Math.sin(a1) * headLength);
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - Math.cos(a2) * headLength, endY - Math.sin(a2) * headLength);
          }
          ctx.lineWidth = tracerWidth;
          ctx.strokeStyle = arrowColor;
          if (offscreenTheme === "dashed") ctx.setLineDash([6, 5]);
          if (offscreenTheme === "neon") {
            ctx.shadowColor = arrowColor;
            ctx.shadowBlur = 10;
          }
          if (arrowStyle === "dot" || arrowStyle === "modern") ctx.fill();
          else ctx.stroke();
          ctx.restore();
          labelX = endX;
          labelY = endY - Math.max(16, headLength * 1.2);
        }
      }

      if (!nameDistanceVisibility.showName && !nameDistanceVisibility.showDistance) continue;
      ctx.fillStyle = nameColor;
      ctx.font = `${nameSize}px ${espCfg.font || "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelText = formatEspLabel(getCharacterName(character, characterId), worldDistance, nameDistanceVisibility, distanceStyle);
      const textWidth = Math.max(1, ctx.measureText(labelText).width);
      const pad = Math.max(8, nameSize * 0.35);
      const halfText = textWidth / 2;
      const drawX = Math.min(canvas.width - halfText - pad, Math.max(halfText + pad, labelX));
      const drawY = Math.min(canvas.height - nameSize - pad, Math.max(nameSize * 0.7 + pad, labelY));
      if (nameOutlineEnabled) {
        ctx.lineWidth = nameOutlineWidth;
        ctx.strokeStyle = nameOutlineColor;
        ctx.lineJoin = "round";
        ctx.strokeText(labelText, drawX, drawY);
      }
      ctx.fillText(labelText, drawX, drawY);

    }

    for (const [id, data] of espState.seenPlayers) {
      if (!activeIds.has(id) && now - Number(data?.t ?? 0) > 900) {
        espState.seenPlayers.delete(id);
      }
    }
  }

  function renderEspTick() {
    if (!espState.enabled || !espState.ctx || !espState.canvas) return;
    const stores = espState.stores ?? window.stores;
    if (!stores) {
      espState.waitLogTick += 1;
      if (espState.waitLogTick % 60 === 0) espLog("Waiting for stores...");
      espState.ctx.clearRect(0, 0, espState.canvas.width, espState.canvas.height);
      return;
    }
    espState.waitLogTick = 0;
    renderEspPlayers(stores);
  }

  function startEsp() {
    if (espState.enabled) {
      espLog("ESP already enabled; skipping duplicate start.");
      return;
    }
    espState.enabled = true;
    espLog("ESP initialized");
    createEspCanvas();
    resizeEspCanvas();
    resolveEspStores().catch((error) => espLog("Failed to resolve stores", error));
    startUnifiedRenderLoop();
  }

  function stopEsp() {
    if (!espState.enabled) {
      espLog("ESP already disabled; skipping duplicate stop.");
      return;
    }
    espState.enabled = false;
    espState.seenPlayers.clear();
    destroyEspCanvas();
    stopUnifiedRenderLoopIfIdle();
    espLog("ESP stopped and cleaned up");
  }

  window.addEventListener("resize", resizeEspCanvas);

  // ---------------------------------------------------------------------------
  // CROSSHAIR MODULE
  // Renders a crosshair at the mouse cursor position and optionally a line
  // from the center of the screen to the cursor.
  // ---------------------------------------------------------------------------
  const crosshairState = {
    enabled: false,
    canvas: null,
    ctx: null,
    mouseX: 0,
    mouseY: 0,
    rafId: null,
    hidNativeCursor: false,
    previousCursor: "",
  };

  function getCrosshairConfig() {
    const defaults = {
      enabled: true,
      style: "x",
      color: "#ff3b3b",
      crosshairSize: 25,
      lineSize: 4,
      showLine: false,
      lineColor: "#ff3b3b",
      tracerLineSize: 1.5,
      hoverHighlight: true,
      hoverColor: "#ffff00",
      showCrosshairGlyph: true,
    };
    const stored = window.__anrrgmCrosshairConfig;
    return stored && typeof stored === "object" ? { ...defaults, ...stored } : defaults;
  }

  function createCrosshairCanvas() {
    if (crosshairState.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10000;pointer-events:none;user-select:none;";
    document.body.appendChild(canvas);
    crosshairState.canvas = canvas;
    crosshairState.ctx = canvas.getContext("2d");
  }

  function destroyCrosshairCanvas() {
    if (crosshairState.rafId != null) { cancelAnimationFrame(crosshairState.rafId); crosshairState.rafId = null; }
    crosshairState.canvas?.remove();
    crosshairState.canvas = null;
    crosshairState.ctx = null;
  }

  function setNativeCursorHidden(hidden) {
    const target = document.body || document.documentElement;
    if (!target) return;
    if (hidden) {
      if (crosshairState.hidNativeCursor) return;
      crosshairState.previousCursor = target.style.cursor || "";
      target.style.cursor = "none";
      crosshairState.hidNativeCursor = true;
      return;
    }
    if (!crosshairState.hidNativeCursor) return;
    target.style.cursor = crosshairState.previousCursor || "";
    crosshairState.previousCursor = "";
    crosshairState.hidNativeCursor = false;
  }

  function disableCrosshairModuleFromEscape() {
    if (!crosshairState.enabled) return;
    const module = state?.modules?.get?.("Crosshair");
    const item = state?.moduleItems?.get?.("Crosshair");
    if (module?.enabled) {
      module.disable();
      item?.classList?.remove("active");
      state?.enabledModules?.delete?.("Crosshair");
      saveSettings();
      return;
    }
    stopCrosshair();
  }

  function shouldIgnoreCrosshairEscapeDisable() {
    if (state?.visible) return true;
    if (state?.listeningForMenuBind || state?.listeningForBind) return true;
    const modal = document.querySelector(".anrrgm-config-backdrop");
    if (modal && !modal.classList.contains("hidden")) return true;
    return false;
  }

  function resizeCrosshairCanvas() {
    if (!crosshairState.canvas) return;
    crosshairState.canvas.width = window.innerWidth;
    crosshairState.canvas.height = window.innerHeight;
  }

  function renderCrosshairFrame() {
    if (!crosshairState.enabled) return;
    const ctx = crosshairState.ctx;
    const canvas = crosshairState.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cfg = getCrosshairConfig();
    if (!cfg.enabled) return;

    const mx = crosshairState.mouseX;
    const my = crosshairState.mouseY;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    const crosshairSize = typeof cfg.crosshairSize === "number" ? cfg.crosshairSize : 25;
    const lineSize      = typeof cfg.lineSize      === "number" ? cfg.lineSize      : 4;
    const tracerSize    = typeof cfg.tracerLineSize === "number" ? cfg.tracerLineSize : 1.5;

    // --- Player hover detection ---
    let hoveringPlayer = false;
    if (cfg.hoverHighlight) {
      try {
        const stores = espState.stores ?? window.stores ?? null;
        const camera = stores?.phaser?.scene?.cameras?.cameras?.[0];
        const me = stores ? getMainCharacter(stores) : null;
        if (camera && me) {
          const camX = Number(camera?.midPoint?.x);
          const camY = Number(camera?.midPoint?.y);
          const zoom = Number(camera?.zoom ?? 1) || 1;
          const hitRadius = (Math.max(20, 120 * zoom) / 2) * 3;
          if (Number.isFinite(camX) && Number.isFinite(camY)) {
            for (const { character } of getCharacterEntries(stores)) {
              if (!character || character === me) continue;
              const pos = getCharacterPosition(character);
              if (!pos) continue;
              const sx = (pos.x - camX) * zoom + canvas.width / 2;
              const sy = (pos.y - camY) * zoom + canvas.height / 2;
              if (Math.hypot(mx - sx, my - sy) <= hitRadius) {
                hoveringPlayer = true;
                break;
              }
            }
          }
        }
      } catch (_) { /* stores not ready yet */ }
    }

    const col = hoveringPlayer ? (cfg.hoverColor || "#ffff00") : (cfg.color || "#ff3b3b");

    // Draw line from center to cursor if enabled
    if (cfg.showLine) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(mx, my);
      ctx.lineWidth = tracerSize;
      ctx.strokeStyle = cfg.lineColor || "#ff3b3b";
      ctx.globalAlpha = 0.65;
      ctx.stroke();
      ctx.restore();
    }

    // Draw crosshair at cursor
    if (!cfg.showCrosshairGlyph) return;
    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = lineSize;
    ctx.globalAlpha = 0.92;
    const style = cfg.style || "cross";

    if (style === "dot") {
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1, crosshairSize * 0.35), 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "solid") {
      // Solid cross — lines go straight through the center with no gap
      const arm = crosshairSize;
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    } else if (style === "crossdot") {
      // Cross with gap + filled center dot
      const arm = crosshairSize;
      const gap = Math.max(1, crosshairSize * 0.4);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
      ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
      ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1.5, lineSize * 1.2), 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "circle") {
      ctx.beginPath();
      ctx.arc(mx, my, crosshairSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1, crosshairSize * 0.2), 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "circlecross") {
      // Circle with solid cross lines through the center
      ctx.beginPath();
      ctx.arc(mx, my, crosshairSize, 0, Math.PI * 2);
      ctx.stroke();
      const arm = crosshairSize;
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    } else if (style === "plus") {
      // Thick plus sign
      ctx.lineWidth = lineSize * 1.5;
      const arm = crosshairSize;
      const gap = Math.max(1, crosshairSize * 0.3);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
      ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
      ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    } else if (style === "x") {
      // Diagonal X crosshair
      const arm = crosshairSize * 0.75;
      const gap = Math.max(1, crosshairSize * 0.28);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my - arm); ctx.lineTo(mx - gap, my - gap);
      ctx.moveTo(mx + gap, my + gap); ctx.lineTo(mx + arm, my + arm);
      ctx.moveTo(mx + arm, my - arm); ctx.lineTo(mx + gap, my - gap);
      ctx.moveTo(mx - gap, my + gap); ctx.lineTo(mx - arm, my + arm);
      ctx.stroke();
    } else {
      // Default "cross" — thin with center gap
      const arm = crosshairSize;
      const gap = Math.max(1, crosshairSize * 0.4);
      ctx.beginPath();
      ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
      ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
      ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
      ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
      ctx.stroke();
    }
    ctx.restore();
  }

  function startCrosshair() {
    if (crosshairState.enabled) return;
    primeSharedPlayerData();
    crosshairState.enabled = true;
    createCrosshairCanvas();
    setNativeCursorHidden(true);
    startUnifiedRenderLoop();
  }

  function stopCrosshair() {
    if (!crosshairState.enabled) return;
    crosshairState.enabled = false;
    setNativeCursorHidden(false);
    destroyCrosshairCanvas();
    stopUnifiedRenderLoopIfIdle();
  }

  document.addEventListener("mousemove", (e) => {
    const dx = e.clientX - crosshairState.mouseX;
    const dy = e.clientY - crosshairState.mouseY;
    const len = Math.hypot(dx, dy);
    if (len > 0.0001) {
      autoAimState.aimDirX = dx / len;
      autoAimState.aimDirY = dy / len;
    }
    crosshairState.mouseX = e.clientX;
    crosshairState.mouseY = e.clientY;
  }, { passive: true });

  window.addEventListener("resize", resizeCrosshairCanvas);
  // ---------------------------------------------------------------------------
  // KEYSTROKES MODULE
  // Minecraft-client-style WASD / mouse / space input overlay with CPS counters.
  // ---------------------------------------------------------------------------
  const KEYSTROKES_MODULE_NAME = "Keystrokes";
  const KEYSTROKES_COLOR_SETTINGS = [
    { id: "keyFillStart", label: "Key Background Start", default: "#000000" },
    { id: "keyFillEnd", label: "Key Background End", default: "#000000" },
    { id: "keyBorder", label: "Key Border", default: "#242424" },
    { id: "keyText", label: "Key Text", default: "#f7f7f7" },
    { id: "keyPressedBg", label: "Pressed Key Background", default: "#383838" },
  ];
  const keystrokesState = {
    enabled: false,
    container: null,
    elements: new Map(),
    pressedKeys: new Set(),
    pressedMouseButtons: new Set(),
    lmbClicks: [],
    rmbClicks: [],
    config: null,
    intervalId: null,
    rafId: null,
    rmbReleaseTimeoutId: null,
    appearanceObserver: null,
    dragState: null,
    listeners: [],
  };

  function getKeystrokesConfig() {
    const defaults = {
      scale: 100,
      x: 18,
      y: 118,
      opacity: 92,
      showCps: true,
      useGlobalAppearance: true,
      keyFillStart: "#000000",
      keyFillEnd: "#000000",
      keyBorder: "#242424",
      keyText: "#f7f7f7",
      keyPressedBg: "#383838",
    };
    const storedCfg = typeof moduleCfg === "function" ? moduleCfg(KEYSTROKES_MODULE_NAME) : null;
    const liveCfg = keystrokesState.config || window.__anrrgmKeystrokesConfig || null;
    return { ...defaults, ...(storedCfg && typeof storedCfg === "object" ? storedCfg : {}), ...(liveCfg && typeof liveCfg === "object" ? liveCfg : {}) };
  }

  function scheduleKeystrokesRender() {
    if (!keystrokesState.enabled || keystrokesState.rafId != null) return;
    keystrokesState.rafId = requestAnimationFrame(() => {
      keystrokesState.rafId = null;
      renderKeystrokesOverlay();
    });
  }

  const KEYSTROKES_CPS_WINDOW_MS = 1000;

  function getKeystrokesCps(clicks, now = performance.now()) {
    while (clicks.length && now - clicks[0] >= KEYSTROKES_CPS_WINDOW_MS) clicks.shift();
    if (!clicks.length) return "0.0";

    // Use high-resolution click timestamps in a rolling one-second window.
    // Each click fades out over the window so the readout shows true decimals
    // and returns to 0.0 immediately when the window is empty instead of
    // hanging on an integer count.
    const weightedClicks = clicks.reduce((total, timestamp) => {
      const age = Math.max(0, now - timestamp);
      return total + Math.max(0, 1 - (age / KEYSTROKES_CPS_WINDOW_MS));
    }, 0);
    const cps = (weightedClicks * 2 * 1000) / KEYSTROKES_CPS_WINDOW_MS;
    return (cps < 0.05 ? 0 : cps).toFixed(1);
  }

  function setKeystrokePressed(id, pressed) {
    const element = keystrokesState.elements.get(id);
    if (!element) return;
    element.classList.toggle("anrrgm-keystroke-pressed", Boolean(pressed));
  }

  function applyKeystrokesThemeVars(overlay) {
    const cfg = getKeystrokesConfig();
    const useGlobal = cfg.useGlobalAppearance !== false;
    const source = useGlobal && typeof root !== "undefined" && root ? getComputedStyle(root) : null;
    const cachedAppearance = useGlobal && window.__anrrgmAppearanceVars && typeof window.__anrrgmAppearanceVars === "object"
      ? window.__anrrgmAppearanceVars
      : null;
    const readVar = (name, fallback) => {
      const cached = cachedAppearance?.[name];
      if (cached != null && String(cached).trim()) return String(cached).trim();
      const value = source?.getPropertyValue?.(name)?.trim();
      return value || fallback;
    };
    const readManualColor = (id) => {
      const setting = KEYSTROKES_COLOR_SETTINGS.find((entry) => entry.id === id);
      const value = cfg[id];
      return value != null && String(value).trim() ? String(value).trim() : setting?.default || "#ffffff";
    };

    overlay.style.setProperty("--anrrgm-key-fill-start", useGlobal ? readVar("--arr-module-disabled-bg", "rgba(0, 0, 0, .72)") : readManualColor("keyFillStart"));
    overlay.style.setProperty("--anrrgm-key-fill-end", useGlobal ? readVar("--arr-module-disabled-bg", "rgba(0, 0, 0, .72)") : readManualColor("keyFillEnd"));
    overlay.style.setProperty("--anrrgm-key-border", useGlobal ? readVar("--arr-module-hover-border", "rgba(255, 255, 255, .14)") : readManualColor("keyBorder"));
    overlay.style.setProperty("--anrrgm-key-text", useGlobal ? readVar("--arr-text", "#f7f7f7") : readManualColor("keyText"));
    overlay.style.setProperty("--anrrgm-key-pressed-bg", useGlobal ? readVar("--arr-module-hover-bg", "rgba(255, 255, 255, .14)") : readManualColor("keyPressedBg"));
    overlay.style.setProperty("--anrrgm-key-font", readVar("--arr-font", "Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"));
    overlay.style.setProperty("--anrrgm-key-radius", readVar("--arr-radius-md", "10px"));
    overlay.style.setProperty("--anrrgm-key-space-radius", readVar("--arr-radius-lg", "10px"));
  }

  function syncKeystrokesConfigChange(cfg = null) {
    const nextCfg = cfg && typeof cfg === "object" ? { ...getKeystrokesConfig(), ...cfg } : getKeystrokesConfig();
    keystrokesState.config = { ...nextCfg };
    window.__anrrgmKeystrokesConfig = { ...nextCfg };
    renderKeystrokesOverlay();
  }

  function renderKeystrokesOverlay() {
    const overlay = keystrokesState.container;
    if (!keystrokesState.enabled || !overlay) return;

    applyKeystrokesThemeVars(overlay);
    const cfg = getKeystrokesConfig();
    const scale = Math.max(0.5, Math.min(2.5, (Number(cfg.scale) || 100) / 100));
    const x = Number.isFinite(Number(cfg.x)) ? Number(cfg.x) : 18;
    const y = Number.isFinite(Number(cfg.y)) ? Number(cfg.y) : 118;
    const opacity = Math.max(0.2, Math.min(1, (Number(cfg.opacity) || 92) / 100));
    const showCps = cfg.showCps !== false;

    overlay.style.left = `${Math.max(0, Math.round(x))}px`;
    overlay.style.top = `${Math.max(0, Math.round(y))}px`;
    overlay.style.transform = `scale(${scale})`;
    overlay.style.opacity = String(opacity);

    const now = performance.now();
    const lmbCps = getKeystrokesCps(keystrokesState.lmbClicks, now);
    const rmbCps = getKeystrokesCps(keystrokesState.rmbClicks, now);
    const lmbText = keystrokesState.elements.get("LMB-text");
    const rmbText = keystrokesState.elements.get("RMB-text");
    if (lmbText) lmbText.innerHTML = showCps ? `<span class="anrrgm-keystroke-mouse-name">LMB</span><span class="anrrgm-keystroke-cps">${lmbCps} CPS</span>` : "LMB";
    if (rmbText) rmbText.innerHTML = showCps ? `<span class="anrrgm-keystroke-mouse-name">RMB</span><span class="anrrgm-keystroke-cps">${rmbCps} CPS</span>` : "RMB";

    setKeystrokePressed("W", keystrokesState.pressedKeys.has("KeyW"));
    setKeystrokePressed("A", keystrokesState.pressedKeys.has("KeyA"));
    setKeystrokePressed("S", keystrokesState.pressedKeys.has("KeyS"));
    setKeystrokePressed("D", keystrokesState.pressedKeys.has("KeyD"));
    setKeystrokePressed("Space", keystrokesState.pressedKeys.has("Space"));
    setKeystrokePressed("LMB", keystrokesState.pressedMouseButtons.has(0));
    setKeystrokePressed("RMB", keystrokesState.pressedMouseButtons.has(2));
  }

  function createKeystrokesKey(id, label, extraClass = "") {
    const key = document.createElement("div");
    key.className = `anrrgm-keystroke-key ${extraClass}`.trim();
    key.dataset.keystrokeId = id;
    key.innerHTML = `<span class="anrrgm-keystroke-label">${label}</span>`;
    keystrokesState.elements.set(id, key);
    return key;
  }

  function ensureKeystrokesOverlay() {
    if (keystrokesState.container?.isConnected) return keystrokesState.container;

    const root = document.createElement("div");
    root.className = "anrrgm-keystrokes-overlay";
    root.style.cssText = [
      "position:fixed",
      "left:18px",
      "top:118px",
      "z-index:2147483646",
      "pointer-events:auto",
      "user-select:none",
      "cursor:move",
      "touch-action:none",
      "transform-origin:top left",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "color:#fff",
      "filter:drop-shadow(0 14px 26px rgba(0,0,0,.42))",
    ].join(";");

    const style = document.createElement("style");
    style.textContent = `
      .anrrgm-keystrokes-overlay { --anrrgm-key-fill-start: rgba(0, 0, 0, .72); --anrrgm-key-fill-end: rgba(0, 0, 0, .72); --anrrgm-key-border: rgba(255, 255, 255, .14); --anrrgm-key-text: #f7f7f7; --anrrgm-key-pressed-bg: rgba(255, 255, 255, .14); --anrrgm-key-font: Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; --anrrgm-key-radius: 10px; --anrrgm-key-space-radius: 10px; }
      .anrrgm-keystrokes-grid { display:grid; grid-template-columns:44px 44px 44px; grid-auto-rows:44px; gap:6px; font-family:var(--anrrgm-key-font); }
      .anrrgm-keystroke-key { box-sizing:border-box; display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; border-radius:var(--anrrgm-key-radius); border:1px solid var(--anrrgm-key-border); background:linear-gradient(180deg, var(--anrrgm-key-fill-start), var(--anrrgm-key-fill-end)); box-shadow:inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(0,0,0,.18); color:var(--anrrgm-key-text); font-weight:900; font-size:15px; letter-spacing:.04em; text-shadow:0 1px 2px rgba(0,0,0,.55); transition:background .08s ease, border-color .08s ease, color .08s ease, box-shadow .08s ease, border-radius .08s ease; }
      .anrrgm-keystroke-pressed { background:var(--anrrgm-key-pressed-bg); border-color:var(--anrrgm-key-border); color:#fff; box-shadow:inset 0 1px 0 rgba(255,255,255,.10), 0 0 0 1px rgba(0,0,0,.18); }
      .anrrgm-keystroke-spacer { visibility:hidden; }
      .anrrgm-keystroke-mouse-row { grid-column:1 / span 3; display:grid; grid-template-columns:1fr 1fr; gap:6px; }
      .anrrgm-keystroke-mouse { min-width:0; width:100%; font-size:11px; line-height:1.1; text-align:center; }
      .anrrgm-keystroke-mouse .anrrgm-keystroke-label { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; width:100%; }
      .anrrgm-keystroke-mouse-name { display:block; font-size:12px; line-height:1; }
      .anrrgm-keystroke-cps { display:block; font-size:11px; line-height:1; white-space:nowrap; }
      .anrrgm-keystroke-space { grid-column:1 / span 3; min-height:28px; height:28px; font-size:12px; border-radius:var(--anrrgm-key-space-radius); }
      .anrrgm-keystroke-label { pointer-events:none; }
    `;
    root.appendChild(style);

    const grid = document.createElement("div");
    grid.className = "anrrgm-keystrokes-grid";

    grid.appendChild(createKeystrokesKey("spacer-top-left", "", "anrrgm-keystroke-spacer"));
    grid.appendChild(createKeystrokesKey("W", "W"));
    grid.appendChild(createKeystrokesKey("spacer-top-right", "", "anrrgm-keystroke-spacer"));
    grid.appendChild(createKeystrokesKey("A", "A"));
    grid.appendChild(createKeystrokesKey("S", "S"));
    grid.appendChild(createKeystrokesKey("D", "D"));

    const lmb = createKeystrokesKey("LMB", `<span class="anrrgm-keystroke-mouse-name">LMB</span><span class="anrrgm-keystroke-cps">0.0 CPS</span>`, "anrrgm-keystroke-mouse");
    const rmb = createKeystrokesKey("RMB", `<span class="anrrgm-keystroke-mouse-name">RMB</span><span class="anrrgm-keystroke-cps">0.0 CPS</span>`, "anrrgm-keystroke-mouse");
    keystrokesState.elements.set("LMB-text", lmb.querySelector(".anrrgm-keystroke-label"));
    keystrokesState.elements.set("RMB-text", rmb.querySelector(".anrrgm-keystroke-label"));
    const mouseRow = document.createElement("div");
    mouseRow.className = "anrrgm-keystroke-mouse-row";
    mouseRow.appendChild(lmb);
    mouseRow.appendChild(rmb);
    grid.appendChild(mouseRow);

    const space = createKeystrokesKey("Space", "SPACE", "anrrgm-keystroke-space");
    grid.appendChild(space);

    root.appendChild(grid);
    document.body.appendChild(root);
    keystrokesState.container = root;
    return root;
  }

  function isKeystrokesOverlayEvent(event) {
    return Boolean(event?.target?.closest?.(".anrrgm-keystrokes-overlay"));
  }

  function clampKeystrokesPosition(x, y) {
    const overlay = keystrokesState.container;
    const rect = overlay?.getBoundingClientRect?.();
    const maxX = Math.max(0, window.innerWidth - (rect?.width || 0));
    const maxY = Math.max(0, window.innerHeight - (rect?.height || 0));
    return {
      x: Math.min(maxX, Math.max(0, Number(x) || 0)),
      y: Math.min(maxY, Math.max(0, Number(y) || 0)),
    };
  }

  function setKeystrokesPosition(x, y, { persist = false } = {}) {
    const overlay = keystrokesState.container;
    if (!overlay) return;
    const clamped = clampKeystrokesPosition(x, y);
    overlay.style.left = `${Math.round(clamped.x)}px`;
    overlay.style.top = `${Math.round(clamped.y)}px`;
    const nextCfg = { ...getKeystrokesConfig(), x: Math.round(clamped.x), y: Math.round(clamped.y) };
    keystrokesState.config = nextCfg;
    window.__anrrgmKeystrokesConfig = { ...nextCfg };
    if (typeof moduleCfg === "function") {
      const cfg = moduleCfg(KEYSTROKES_MODULE_NAME);
      cfg.x = nextCfg.x;
      cfg.y = nextCfg.y;
    }
    if (persist && typeof saveSettings === "function") saveSettings();
  }

  function addKeystrokesListener(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    keystrokesState.listeners.push({ target, type, handler, options });
  }

  function clearKeystrokesInputState() {
    keystrokesState.pressedKeys.clear();
    keystrokesState.pressedMouseButtons.clear();
    scheduleKeystrokesRender();
  }

  function startKeystrokesAppearanceObserver() {
    keystrokesState.appearanceObserver?.disconnect?.();
    if (typeof MutationObserver === "undefined" || typeof root === "undefined" || !root) return;
    keystrokesState.appearanceObserver = new MutationObserver(() => scheduleKeystrokesRender());
    keystrokesState.appearanceObserver.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  }

  function stopKeystrokesAppearanceObserver() {
    keystrokesState.appearanceObserver?.disconnect?.();
    keystrokesState.appearanceObserver = null;
  }

  function startKeystrokes() {
    if (keystrokesState.enabled) return;
    keystrokesState.enabled = true;
    keystrokesState.pressedKeys.clear();
    keystrokesState.pressedMouseButtons.clear();
    keystrokesState.dragState = null;
    keystrokesState.lmbClicks = [];
    keystrokesState.rmbClicks = [];
    keystrokesState.config = getKeystrokesConfig();
    window.__anrrgmKeystrokesConfig = { ...keystrokesState.config };
    const overlay = ensureKeystrokesOverlay();
    startKeystrokesAppearanceObserver();

    const handleOverlayMouseDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = overlay.getBoundingClientRect();
      keystrokesState.dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      overlay.style.cursor = "grabbing";
      clearKeystrokesInputState();
      const handleDragMove = (moveEvent) => {
        if (!keystrokesState.dragState) return;
        moveEvent.preventDefault();
        setKeystrokesPosition(moveEvent.clientX - keystrokesState.dragState.offsetX, moveEvent.clientY - keystrokesState.dragState.offsetY);
      };
      const handleDragEnd = () => {
        if (!keystrokesState.dragState) return;
        keystrokesState.dragState = null;
        overlay.style.cursor = "move";
        setKeystrokesPosition(parseFloat(overlay.style.left) || 0, parseFloat(overlay.style.top) || 0, { persist: true });
        document.removeEventListener("mousemove", handleDragMove);
        document.removeEventListener("mouseup", handleDragEnd);
      };
      document.addEventListener("mousemove", handleDragMove);
      document.addEventListener("mouseup", handleDragEnd);
    };

    const handleKeyDown = (event) => {
      if (!["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) return;
      keystrokesState.pressedKeys.add(event.code);
      scheduleKeystrokesRender();
    };
    const handleKeyUp = (event) => {
      if (!["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) return;
      keystrokesState.pressedKeys.delete(event.code);
      scheduleKeystrokesRender();
    };
    const handleMouseDown = (event) => {
      if (isKeystrokesOverlayEvent(event) || keystrokesState.dragState) return;
      if (event.button !== 0 && event.button !== 2) return;
      const now = performance.now();
      if (event.button === 2 && keystrokesState.rmbReleaseTimeoutId != null) {
        clearTimeout(keystrokesState.rmbReleaseTimeoutId);
        keystrokesState.rmbReleaseTimeoutId = null;
      }
      keystrokesState.pressedMouseButtons.add(event.button);
      if (event.button === 0) keystrokesState.lmbClicks.push(now);
      if (event.button === 2) keystrokesState.rmbClicks.push(now);
      scheduleKeystrokesRender();
    };
    const handleMouseUp = (event) => {
      if (isKeystrokesOverlayEvent(event) || keystrokesState.dragState) return;
      if (event.button !== 0 && event.button !== 2) return;
      keystrokesState.pressedMouseButtons.delete(event.button);
      scheduleKeystrokesRender();
    };
    const handleContextMenu = (event) => {
      if (isKeystrokesOverlayEvent(event) || keystrokesState.dragState) return;
      if (keystrokesState.rmbReleaseTimeoutId != null) clearTimeout(keystrokesState.rmbReleaseTimeoutId);
      keystrokesState.pressedMouseButtons.add(2);
      scheduleKeystrokesRender();
      keystrokesState.rmbReleaseTimeoutId = setTimeout(() => {
        keystrokesState.rmbReleaseTimeoutId = null;
        keystrokesState.pressedMouseButtons.delete(2);
        scheduleKeystrokesRender();
      }, 180);
    };
    const handleMouseMove = (event) => {
      if (isKeystrokesOverlayEvent(event) || keystrokesState.dragState) return;
      const buttons = Number(event.buttons) || 0;
      if ((buttons & 1) === 0) keystrokesState.pressedMouseButtons.delete(0);
      if ((buttons & 2) === 0 && keystrokesState.rmbReleaseTimeoutId == null) keystrokesState.pressedMouseButtons.delete(2);
      scheduleKeystrokesRender();
    };

    addKeystrokesListener(overlay, "mousedown", handleOverlayMouseDown, { capture: true });
    addKeystrokesListener(window, "keydown", handleKeyDown, { passive: true, capture: true });
    addKeystrokesListener(window, "keyup", handleKeyUp, { passive: true, capture: true });
    addKeystrokesListener(window, "mousedown", handleMouseDown, { passive: true, capture: true });
    addKeystrokesListener(window, "mouseup", handleMouseUp, { passive: true, capture: true });
    addKeystrokesListener(window, "contextmenu", handleContextMenu, { passive: true, capture: true });
    addKeystrokesListener(window, "mousemove", handleMouseMove, { passive: true, capture: true });
    addKeystrokesListener(window, "blur", clearKeystrokesInputState, { passive: true });
    addKeystrokesListener(document, "visibilitychange", clearKeystrokesInputState, { passive: true });

    keystrokesState.intervalId = setInterval(scheduleKeystrokesRender, 50);
    renderKeystrokesOverlay();
  }

  function stopKeystrokes() {
    if (!keystrokesState.enabled && !keystrokesState.container) return;
    keystrokesState.enabled = false;
    if (keystrokesState.intervalId != null) {
      clearInterval(keystrokesState.intervalId);
      keystrokesState.intervalId = null;
    }
    if (keystrokesState.rafId != null) {
      cancelAnimationFrame(keystrokesState.rafId);
      keystrokesState.rafId = null;
    }
    if (keystrokesState.rmbReleaseTimeoutId != null) {
      clearTimeout(keystrokesState.rmbReleaseTimeoutId);
      keystrokesState.rmbReleaseTimeoutId = null;
    }
    stopKeystrokesAppearanceObserver();
    for (const { target, type, handler, options } of keystrokesState.listeners) {
      target.removeEventListener(type, handler, options);
    }
    keystrokesState.listeners = [];
    keystrokesState.pressedKeys.clear();
    keystrokesState.pressedMouseButtons.clear();
    keystrokesState.dragState = null;
    keystrokesState.lmbClicks = [];
    keystrokesState.rmbClicks = [];
    keystrokesState.config = null;
    keystrokesState.elements.clear();
    keystrokesState.container?.remove();
    keystrokesState.container = null;
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setTimeout(() => {
      if (shouldIgnoreCrosshairEscapeDisable()) return;
      if (document.pointerLockElement) return;
      disableCrosshairModuleFromEscape();
    }, 0);
  }, false);

  // ---------------------------------------------------------------------------
  // TRIGGER ASSIST MODULE
  // Uses shared ESP bridge data and cursor position to trigger fire when
  // player targets are within a configurable cursor radius.
  // ---------------------------------------------------------------------------
  const triggerAssistState = {
    enabled: false,
    loopId: null,
    canvas: null,
    ctx: null,
    lastFireAt: 0,
    mouseHeld: false,
    releaseTimeoutId: null,
    target: null,
    statusText: "Idle",
  };

  const quickFireState = {
    enabled: false,
    timerId: null,
    rafId: null,
    messageChannel: null,
    loopPending: false,
    fireIntervalMs: 5,
    lastLoopAt: 0,
    nextShotAt: 0,
    packetTokens: 0,
    lastTokenAt: 0,
    lastStatus: "Idle",
    statusText: "Idle",
  };

  const quickFireInputState = {
    leftMouseDown: false,
  };

  const autoAimState = {
    enabled: false,
    rafId: null,
    canvas: null,
    ctx: null,
    target: null,
    statusText: "Idle",
    lastAimX: 0,
    lastAimY: 0,
    aimDirX: 1,
    aimDirY: 0,
    lastTickAt: 0,
    lastTargetId: null,
    targetLockUntil: 0,
    targetVelX: 0,
    targetVelY: 0,
    lastTargetSampleAt: 0,
  };

  const autoAimInputState = {
    leftMouseDown: false,
    reroutedShotActive: false,
  };

  function getTriggerAssistConfig() {
    const defaults = {
      enabled: true,
      teamCheck: true,
      fovPx: 220,
      holdToFire: false,
      fireRateMs: 16,
      requireLOS: false,
      onlyWhenGameFocused: true,
      showTargetRing: true,
    };
    const stored = window.__anrrgmTriggerAssistConfig;
    return stored && typeof stored === "object" ? { ...defaults, ...stored } : defaults;
  }

  function getQuickFireConfig() {
    const defaults = {
      enabled: true,
      fireIntervalMs: 5,
      maxBurstPerTick: 8,
      maxPacketsPerSecond: 500,
      maxCatchupMs: 100,
      socketBufferLimitBytes: 262144,
      schedulerMode: "auto",
      alwaysFire: false,
      onlyWhenGameFocused: true,
    };
    const stored = window.__anrrgmQuickFireConfig;
    if (stored && typeof stored === "object") {
      const migrated = { ...defaults };
      if (Object.prototype.hasOwnProperty.call(stored, "enabled")) migrated.enabled = Boolean(stored.enabled);
      if (Object.prototype.hasOwnProperty.call(stored, "fireIntervalMs")) migrated.fireIntervalMs = stored.fireIntervalMs;
      if (Object.prototype.hasOwnProperty.call(stored, "onlyWhenGameFocused")) migrated.onlyWhenGameFocused = Boolean(stored.onlyWhenGameFocused);
      if (Object.prototype.hasOwnProperty.call(stored, "alwaysFire")) {
        migrated.alwaysFire = Boolean(stored.alwaysFire);
      } else if (Object.prototype.hasOwnProperty.call(stored, "onlyWhenMouseDown")) {
        migrated.alwaysFire = stored.onlyWhenMouseDown === false;
      }
      return migrated;
    }
    return defaults;
  }

  function getAutoAimConfig() {
    const defaults = {
      enabled: true,
      teamCheck: true,
      fovDeg: 180,
      smoothing: 0,
      maxStepPx: 120,
      minStepPx: 0,
      deadzonePx: 0,
      predictionMs: 0,
      lockMs: 0,
      stickToTarget: false,
      onlyWhenGameFocused: true,
      requireMouseDown: false,
      showDebugDot: true,
    };
    const stored = window.__anrrgmAutoAimConfig;
    if (stored && typeof stored === "object") {
      const merged = { ...defaults, ...stored };
      if (merged.fovDeg == null && Number.isFinite(Number(stored.fovPx))) {
        merged.fovDeg = Math.max(15, Math.min(180, Number(stored.fovPx)));
      }
      return merged;
    }
    return defaults;
  }

  function createTriggerAssistCanvas() {
    if (triggerAssistState.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10001;pointer-events:none;user-select:none;";
    document.body.appendChild(canvas);
    triggerAssistState.canvas = canvas;
    triggerAssistState.ctx = canvas.getContext("2d");
  }

  function destroyTriggerAssistCanvas() {
    triggerAssistState.canvas?.remove();
    triggerAssistState.canvas = null;
    triggerAssistState.ctx = null;
  }

  function resizeTriggerAssistCanvas() {
    if (!triggerAssistState.canvas) return;
    triggerAssistState.canvas.width = window.innerWidth;
    triggerAssistState.canvas.height = window.innerHeight;
  }

  function createAutoAimCanvas() {
    if (autoAimState.canvas?.parentNode) return;
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10002;pointer-events:none;user-select:none;";
    document.body.appendChild(canvas);
    autoAimState.canvas = canvas;
    autoAimState.ctx = canvas.getContext("2d");
  }

  function destroyAutoAimCanvas() {
    autoAimState.canvas?.remove();
    autoAimState.canvas = null;
    autoAimState.ctx = null;
  }

  function resizeAutoAimCanvas() {
    if (!autoAimState.canvas) return;
    autoAimState.canvas.width = window.innerWidth;
    autoAimState.canvas.height = window.innerHeight;
  }

  function getGameCanvas() {
    const stores = espState.stores ?? window.stores;
    return stores?.phaser?.game?.canvas
      ?? stores?.phaser?.scene?.game?.canvas
      ?? document.querySelector("canvas");
  }

  function fireCanvasPointerEvent(type, canvas, x, y) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + Math.max(0, Math.min(rect.width, x));
    const clientY = rect.top + Math.max(0, Math.min(rect.height, y));
    const init = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "pointerup" || type === "mouseup" ? 0 : 1,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    canvas.dispatchEvent(new PointerEvent(type, init));
  }

  function fireCanvasMouseEvent(type, canvas, x, y, buttons = 0) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + Math.max(0, Math.min(rect.width, x));
    const clientY = rect.top + Math.max(0, Math.min(rect.height, y));
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    }));
  }


  function syncPhaserPointer(x, y) {
    try {
      const stores = espState.stores ?? window.stores;
      const scene = stores?.phaser?.scene;
      const input = scene?.input;
      const pointer = input?.activePointer || input?.mousePointer;
      if (!pointer) return;
      const nx = Math.max(0, Math.min(window.innerWidth, Number(x) || 0));
      const ny = Math.max(0, Math.min(window.innerHeight, Number(y) || 0));
      pointer.x = nx;
      pointer.y = ny;
      pointer.position?.set?.(nx, ny);
      pointer.prevPosition?.set?.(nx, ny);
      if (typeof scene?.cameras?.main?.getWorldPoint === "function") {
        const worldPoint = scene.cameras.main.getWorldPoint(nx, ny);
        if (worldPoint) {
          pointer.worldX = worldPoint.x;
          pointer.worldY = worldPoint.y;
        }
      }
    } catch (_) {}
  }

  function syncAimPointer(canvas, x, y, buttons = 0) {
    syncPhaserPointer(x, y);
    fireCanvasPointerEvent("pointermove", canvas, x, y);
    fireCanvasMouseEvent("mousemove", canvas, x, y, buttons);
    const clientX = Math.max(0, Math.min(window.innerWidth, Number(x) || 0));
    const clientY = Math.max(0, Math.min(window.innerHeight, Number(y) || 0));
    const moveInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    };
    document.dispatchEvent(new MouseEvent("mousemove", moveInit));
    window.dispatchEvent(new MouseEvent("mousemove", moveInit));
    try {
      const pointerInit = {
        ...moveInit,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      };
      document.dispatchEvent(new PointerEvent("pointermove", pointerInit));
      window.dispatchEvent(new PointerEvent("pointermove", pointerInit));
    } catch (_) { }
  }

  function releaseFireHold() {
    if (!triggerAssistState.mouseHeld) return;
    const canvas = getGameCanvas();
    if (canvas) {
      syncAimPointer(canvas, crosshairState.mouseX, crosshairState.mouseY, 0);
      fireCanvasPointerEvent("pointerup", canvas, crosshairState.mouseX, crosshairState.mouseY);
      fireCanvasMouseEvent("mouseup", canvas, crosshairState.mouseX, crosshairState.mouseY, 0);
    }
    triggerAssistState.mouseHeld = false;
  }

  function attemptFire(hold, forceRelease = false, point = null) {
    const canvas = getGameCanvas();
    if (!canvas) return false;
    canvas.focus?.({ preventScroll: true });
    const aimX = Number(point?.x ?? crosshairState.mouseX);
    const aimY = Number(point?.y ?? crosshairState.mouseY);

    if (forceRelease) {
      releaseFireHold();
      return true;
    }

    if (hold) {
      syncAimPointer(canvas, aimX, aimY, 1);
      if (!triggerAssistState.mouseHeld) {
        fireCanvasPointerEvent("pointerdown", canvas, aimX, aimY);
        fireCanvasMouseEvent("mousedown", canvas, aimX, aimY, 1);
        triggerAssistState.mouseHeld = true;
      }
      return true;
    }

    syncAimPointer(canvas, aimX, aimY, 1);
    fireCanvasPointerEvent("pointerdown", canvas, aimX, aimY);
    fireCanvasMouseEvent("mousedown", canvas, aimX, aimY, 1);
    setTimeout(() => {
      syncAimPointer(canvas, aimX, aimY, 0);
      fireCanvasPointerEvent("pointerup", canvas, aimX, aimY);
      fireCanvasMouseEvent("mouseup", canvas, aimX, aimY, 0);
    }, 12);
    return true;
  }

  function findTriggerTarget(cfg) {
    const snapshot = getAutoAimPlayerSnapshot();
    if (!snapshot?.camera || !Array.isArray(snapshot.players)) return null;
    const mx = crosshairState.mouseX;
    const my = crosshairState.mouseY;
    const espCfg = getEspRenderConfig();
    const baseHitbox = Math.max(12, Number(espCfg.hitboxSize) || 150);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = 80;
    let best = null;
    for (const player of snapshot.players) {
      if (!player) continue;
      const pid = String(player.id ?? "");
      if (!pid || (snapshot.localPlayerId != null && pid === String(snapshot.localPlayerId))) continue;
      if (cfg.teamCheck && snapshot.localTeamId != null && player.teamId === snapshot.localTeamId) continue;
      const screen = projectWorldToScreen(player, snapshot.camera, width, height);
      if (!screen) continue;
      if (screen.x < -margin || screen.x > width + margin || screen.y < -margin || screen.y > height + margin) continue;
      const boxSize = Math.max(24, baseHitbox * Math.max(0.01, Number(screen.zoom) || 1));
      const half = boxSize * 0.5;
      if (mx < screen.x - half || mx > screen.x + half || my < screen.y - half || my > screen.y + half) continue;
      const dist = Math.hypot(mx - screen.x, my - screen.y);
      if (!best || dist < best.distancePx) {
        best = {
          player,
          screenX: screen.x,
          screenY: screen.y,
          distancePx: dist,
          hitboxSizePx: boxSize,
        };
      }
    }
    return best;
  }

  function getAutoAimPlayerSnapshot() {
    const shared = window.__anrrgmEspShared;
    if (shared?.ready && Array.isArray(shared.players) && shared.camera) {
      return {
        localPlayerId: shared.localPlayerId ?? null,
        localTeamId: shared.localTeamId ?? null,
        camera: shared.camera,
        players: shared.players,
      };
    }

    const stores = espState.stores ?? window.stores ?? null;
    const me = stores ? getMainCharacter(stores) : null;
    const cam = stores?.phaser?.scene?.cameras?.cameras?.[0];
    if (!me || !cam) return null;
    const mePos = getCharacterPosition(me);
    const meId = String(getCharacterId(me) ?? stores?.phaser?.mainCharacter?.id ?? "");
    const meTeam = getCharacterTeam(me);
    const fallbackPlayers = [];
    for (const { id, character } of getCharacterEntries(stores)) {
      const pos = getCharacterPosition(character);
      if (!pos) continue;
      fallbackPlayers.push({
        id: String(id ?? getCharacterId(character) ?? ""),
        name: String(getCharacterName(character, id)),
        teamId: getCharacterTeam(character),
        x: pos.x,
        y: pos.y,
      });
    }
    return {
      localPlayerId: meId || (mePos ? `${mePos.x}:${mePos.y}` : null),
      localTeamId: meTeam ?? null,
      camera: {
        midX: Number(cam?.midPoint?.x ?? 0),
        midY: Number(cam?.midPoint?.y ?? 0),
        zoom: Number(cam?.zoom ?? 1),
      },
      players: fallbackPlayers,
    };
  }

  function findAutoAimTarget(cfg) {
    const snapshot = getAutoAimPlayerSnapshot();
    if (!snapshot?.camera || !Array.isArray(snapshot.players)) return null;
    const mx = crosshairState.mouseX;
    const my = crosshairState.mouseY;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = 80;
    const fovDeg = Math.max(15, Math.min(180, Number(cfg.fovDeg) || 120));
    const stickyFovDeg = Math.min(180, fovDeg * 1.15);
    const aimDirX = Number(autoAimState.aimDirX) || 1;
    const aimDirY = Number(autoAimState.aimDirY) || 0;
    const angleToAimDir = (toX, toY) => {
      const len = Math.hypot(toX, toY);
      if (len <= 0.001) return 0;
      const nx = toX / len;
      const ny = toY / len;
      const dot = Math.max(-1, Math.min(1, nx * aimDirX + ny * aimDirY));
      return Math.acos(dot) * (180 / Math.PI);
    };
    const canUseSticky = cfg.stickToTarget && autoAimState.target?.player;
    const now = performance.now();
    const isWithinLockWindow = autoAimState.lastTargetId != null && now < autoAimState.targetLockUntil;
    let stickyCandidate = null;
    let best = null;

    for (const player of snapshot.players) {
      if (!player) continue;
      const pid = String(player.id ?? "");
      if (!pid || (snapshot.localPlayerId != null && pid === String(snapshot.localPlayerId))) continue;
      if (cfg.teamCheck && snapshot.localTeamId != null && player.teamId === snapshot.localTeamId) continue;
      const screen = projectWorldToScreen(player, snapshot.camera, width, height);
      if (!screen) continue;
      if (screen.x < -margin || screen.x > width + margin || screen.y < -margin || screen.y > height + margin) continue;
      const dist = Math.hypot(mx - screen.x, my - screen.y);
      const angleDelta = angleToAimDir(screen.x - mx, screen.y - my);
      const score = dist;
      if (angleDelta <= fovDeg && (!best || score < best.score)) {
        best = { player, playerId: pid, screenX: screen.x, screenY: screen.y, distancePx: dist, angleDelta, score };
      }
      if (canUseSticky && pid === String(autoAimState.target.playerId) && angleDelta <= stickyFovDeg) {
        stickyCandidate = { player, playerId: pid, screenX: screen.x, screenY: screen.y, distancePx: dist, angleDelta, score };
      } else if (isWithinLockWindow && pid === String(autoAimState.lastTargetId) && angleDelta <= stickyFovDeg) {
        stickyCandidate = { player, playerId: pid, screenX: screen.x, screenY: screen.y, distancePx: dist, angleDelta, score };
      }
    }
    return stickyCandidate || best;
  }

  function renderAutoAimOverlay(cfg) {
    const ctx = autoAimState.ctx;
    const canvas = autoAimState.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cfg.showDebugDot || !autoAimState.target) return;
    const pulse = (Math.sin(performance.now() / 140) + 1) * 0.5;
    const tx = autoAimState.target.screenX;
    const ty = autoAimState.target.screenY;
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + pulse * 0.2})`;
    ctx.strokeStyle = `rgba(255, 92, 92, ${0.7 + pulse * 0.2})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(tx, ty, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tx, ty, 7 + pulse * 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function autoAimTick() {
    if (!autoAimState.enabled) return;
    const now = performance.now();
    const dtMs = autoAimState.lastTickAt > 0 ? (now - autoAimState.lastTickAt) : (1000 / 60);
    autoAimState.lastTickAt = now;
    const dtFactor = Math.max(0.45, Math.min(2.2, dtMs / (1000 / 60)));
    const cfg = getAutoAimConfig();
    if (!cfg.enabled) {
      autoAimState.target = null;
      autoAimState.statusText = "Disabled in config";
      renderAutoAimOverlay(cfg);
      return;
    }
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) {
      autoAimState.target = null;
      autoAimState.statusText = "Waiting for focus";
      renderAutoAimOverlay(cfg);
      return;
    }
    if (cfg.requireMouseDown && !autoAimInputState.leftMouseDown) {
      autoAimState.target = null;
      autoAimState.statusText = "Waiting for mouse hold";
      renderAutoAimOverlay(cfg);
      return;
    }

    const prevTarget = autoAimState.target;
    const target = findAutoAimTarget(cfg);
    autoAimState.target = target;
    if (!target) {
      const hasShared = window.__anrrgmEspShared?.ready;
      const hasStores = Boolean((espState.stores ?? window.stores)?.phaser?.scene);
      autoAimState.statusText = (!hasShared && !hasStores) ? "Waiting for match data" : "No target";
      renderAutoAimOverlay(cfg);
      return;
    }

    const canvas = getGameCanvas();
    const smoothingValue = Number(cfg.smoothing);
    const smoothing = Math.max(0, Math.min(1, Number.isFinite(smoothingValue) ? smoothingValue : 0.2));
    const maxStep = Math.max(2, Number(cfg.maxStepPx) || 32);
    const minStepRaw = Number(cfg.minStepPx);
    const minStepAbs = Math.max(0.05, Number.isFinite(minStepRaw) ? minStepRaw : 0.35);
    const minMoveFactor = 0.01;
    const deadzone = Math.max(0, Number(cfg.deadzonePx) || 1.8);
    const predictionMs = Math.max(0, Math.min(220, Number(cfg.predictionMs) || 70));
    const lockMs = Math.max(0, Number(cfg.lockMs) || 220);

    if (target.playerId != null) {
      if (autoAimState.lastTargetId !== String(target.playerId)) {
        autoAimState.targetVelX = 0;
        autoAimState.targetVelY = 0;
      }
      if (prevTarget && prevTarget.playerId === String(target.playerId)) {
        const sampleDelta = Math.max(1, now - (autoAimState.lastTargetSampleAt || now));
        const rawVelX = (target.screenX - prevTarget.screenX) / sampleDelta;
        const rawVelY = (target.screenY - prevTarget.screenY) / sampleDelta;
        const velBlend = 0.28;
        autoAimState.targetVelX = autoAimState.targetVelX * (1 - velBlend) + rawVelX * velBlend;
        autoAimState.targetVelY = autoAimState.targetVelY * (1 - velBlend) + rawVelY * velBlend;
      }
      autoAimState.lastTargetSampleAt = now;
      autoAimState.lastTargetId = String(target.playerId);
      autoAimState.targetLockUntil = now + lockMs;
    }

    const predictedX = target.screenX + autoAimState.targetVelX * predictionMs;
    const predictedY = target.screenY + autoAimState.targetVelY * predictionMs;
    const dx = predictedX - crosshairState.mouseX;
    const dy = predictedY - crosshairState.mouseY;
    const dist = Math.hypot(dx, dy);
    if (dist > deadzone) {
      const adaptiveSmoothing = Math.pow(smoothing, dtFactor);
      const moveFactor = Math.max(minMoveFactor, Math.min(1, 1 - adaptiveSmoothing));
      const baseStep = dist * moveFactor;
      const step = Math.min(maxStep * dtFactor, Math.max(minStepAbs, baseStep));
      const ratio = Math.min(1, step / dist);
      const nextX = crosshairState.mouseX + dx * ratio;
      const nextY = crosshairState.mouseY + dy * ratio;
      const moveX = nextX - crosshairState.mouseX;
      const moveY = nextY - crosshairState.mouseY;
      const moveLen = Math.hypot(moveX, moveY);
      if (moveLen > 0.0001) {
        autoAimState.aimDirX = moveX / moveLen;
        autoAimState.aimDirY = moveY / moveLen;
      }
      crosshairState.mouseX = nextX;
      crosshairState.mouseY = nextY;
      autoAimState.lastAimX = nextX;
      autoAimState.lastAimY = nextY;
      if (canvas) syncAimPointer(canvas, nextX, nextY, autoAimInputState.leftMouseDown ? 1 : 0);
    }
    autoAimState.statusText = `Locked: ${target.player?.name ?? "Player"}`;
    renderAutoAimOverlay(cfg);
  }

  function autoAimLoop() {
    if (!autoAimState.enabled) return;
    autoAimTick();
  }

  function startAutoAim() {
    if (autoAimState.enabled) return;
    primeSharedPlayerData();
    autoAimState.enabled = true;
    autoAimState.target = null;
    autoAimState.lastTargetId = null;
    autoAimState.targetLockUntil = 0;
    autoAimState.targetVelX = 0;
    autoAimState.targetVelY = 0;
    autoAimState.lastTickAt = 0;
    autoAimState.statusText = "Armed";
    createAutoAimCanvas();
    startUnifiedRenderLoop();
  }

  function stopAutoAim() {
    if (!autoAimState.enabled) return;
    autoAimState.enabled = false;
    autoAimState.target = null;
    autoAimState.lastTargetId = null;
    autoAimState.targetLockUntil = 0;
    autoAimState.targetVelX = 0;
    autoAimState.targetVelY = 0;
    autoAimState.statusText = "Idle";
    destroyAutoAimCanvas();
    stopUnifiedRenderLoopIfIdle();
  }

  function renderTriggerAssistOverlay(cfg) {
    const ctx = triggerAssistState.ctx;
    const canvas = triggerAssistState.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cfg.showTargetRing || !triggerAssistState.target) return;
    const pulse = (Math.sin(performance.now() / 120) + 1) * 0.5;
    const ringR = Math.max(10, Number(cfg.fovPx) || 85);
    ctx.save();
    const ringGradient = ctx.createRadialGradient(
      crosshairState.mouseX,
      crosshairState.mouseY,
      Math.max(1, ringR * 0.1),
      crosshairState.mouseX,
      crosshairState.mouseY,
      ringR
    );
    ringGradient.addColorStop(0, "rgba(255, 130, 130, 0.12)");
    ringGradient.addColorStop(1, "rgba(255, 40, 40, 0.02)");
    ctx.fillStyle = ringGradient;
    ctx.beginPath();
    ctx.arc(crosshairState.mouseX, crosshairState.mouseY, ringR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 70, 70, ${0.7 + pulse * 0.25})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(crosshairState.mouseX, crosshairState.mouseY, ringR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = `rgba(255, 225, 120, ${0.55 + pulse * 0.35})`;
    ctx.beginPath();
    ctx.moveTo(crosshairState.mouseX, crosshairState.mouseY);
    ctx.lineTo(triggerAssistState.target.screenX, triggerAssistState.target.screenY);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(255, 255, 120, ${0.8 + pulse * 0.2})`;
    ctx.beginPath();
    ctx.arc(triggerAssistState.target.screenX, triggerAssistState.target.screenY, 10 + pulse * 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function setQuickFireStatus(status) {
    quickFireState.lastStatus = status;
    quickFireState.statusText = status;
  }

  function isQuickFireMouseDown(pointer) {
    const pointerButtons = Number(pointer?.buttons) || 0;
    return Boolean(pointer?.isDown || pointer?.leftButtonDown?.() || (pointerButtons & 1) || quickFireInputState.leftMouseDown);
  }

  function getQuickFireBody(phaser, stores) {
    return phaser?.mainCharacter?.body
      ?? getMainCharacter(stores)?.body
      ?? phaser?.scene?.characterManager?.characters?.get?.(phaser?.mainCharacter?.id)?.body
      ?? phaser?.mainCharacter
      ?? null;
  }

  function getQuickFirePointerWorld(pointer, scene) {
    const directX = Number(pointer?.worldX);
    const directY = Number(pointer?.worldY);
    if (Number.isFinite(directX) && Number.isFinite(directY)) return { x: directX, y: directY };

    const pointerX = Number(pointer?.x ?? pointer?.position?.x);
    const pointerY = Number(pointer?.y ?? pointer?.position?.y);
    if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return null;

    const camera = scene?.cameras?.main ?? scene?.cameras?.cameras?.[0];
    const worldPoint = camera?.getWorldPoint?.(pointerX, pointerY);
    const worldX = Number(worldPoint?.x);
    const worldY = Number(worldPoint?.y);
    if (Number.isFinite(worldX) && Number.isFinite(worldY)) return { x: worldX, y: worldY };

    const cameraPoint = pointer?.positionToCamera?.(camera);
    const cameraX = Number(cameraPoint?.x);
    const cameraY = Number(cameraPoint?.y);
    if (Number.isFinite(cameraX) && Number.isFinite(cameraY)) return { x: cameraX, y: cameraY };
    return null;
  }

  function getQuickFireGameObjects() {
    const stores = espState.stores ?? window.stores;
    const phaser = stores?.phaser;
    const scene = phaser?.scene;
    const input = scene?.input;
    const mousePointer = input?.mousePointer ?? input?.activePointer ?? input?.manager?.activePointer ?? input?.pointers?.[0];
    const body = getQuickFireBody(phaser, stores);
    return { stores, phaser, scene, mousePointer, body };
  }

  function normalizeQuickFireConfig(cfg = getQuickFireConfig()) {
    const rawInterval = Number(cfg.fireIntervalMs);
    const rawBurst = Number(cfg.maxBurstPerTick);
    const rawPps = Number(cfg.maxPacketsPerSecond);
    const rawCatchup = Number(cfg.maxCatchupMs);
    const rawBufferLimit = Number(cfg.socketBufferLimitBytes);
    const schedulerMode = ["auto", "timer", "raf", "messageChannel"].includes(cfg.schedulerMode)
      ? cfg.schedulerMode
      : "auto";
    return {
      ...cfg,
      fireIntervalMs: Number.isFinite(rawInterval) ? Math.max(0, Math.min(250, rawInterval)) : 5,
      maxBurstPerTick: Number.isFinite(rawBurst) ? Math.max(1, Math.min(100, Math.floor(rawBurst))) : 8,
      maxPacketsPerSecond: Number.isFinite(rawPps) ? Math.max(1, Math.min(2000, Math.floor(rawPps))) : 500,
      maxCatchupMs: Number.isFinite(rawCatchup) ? Math.max(0, Math.min(1000, rawCatchup)) : 100,
      socketBufferLimitBytes: Number.isFinite(rawBufferLimit) ? Math.max(0, Math.min(4194304, Math.floor(rawBufferLimit))) : 262144,
      schedulerMode,
    };
  }

  function isQuickFireSocketReady() {
    if (!socketManager?.socket) {
      setQuickFireStatus("Waiting for socket");
      return false;
    }
    const socketUrl = String(socketManager.socket?.url || "");
    const transport = socketManager.transportType !== "unknown"
      ? socketManager.transportType
      : (socketUrl.includes("/socket.io/") ? "blueboat" : "colyseus");
    if (transport === "blueboat" && !socketManager.blueboatRoomId) {
      setQuickFireStatus("Waiting for room");
      return false;
    }
    return true;
  }

  function getQuickFireBufferedAmount() {
    const socket = socketManager?.socket;
    const directAmount = Number(socket?.bufferedAmount);
    if (Number.isFinite(directAmount)) return directAmount;
    const transportAmount = Number(socket?.conn?.transport?.ws?.bufferedAmount ?? socket?.transport?.ws?.bufferedAmount);
    return Number.isFinite(transportAmount) ? transportAmount : 0;
  }

  function sendQuickFireMessage(angle, bodyX, bodyY) {
    if (!isQuickFireSocketReady()) return false;
    socketManager.sendMessage("FIRE", { angle, x: bodyX, y: bodyY });
    return true;
  }

  function buildQuickFireShot(cfg) {
    if (!cfg.enabled) {
      setQuickFireStatus("Disabled in config");
      return null;
    }
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) {
      setQuickFireStatus("Waiting for focus");
      return null;
    }
    if (!isQuickFireSocketReady()) return null;

    const { scene, mousePointer, body } = getQuickFireGameObjects();
    if (!mousePointer || !body) {
      setQuickFireStatus("Waiting for game objects");
      return null;
    }
    if (!cfg.alwaysFire && !isQuickFireMouseDown(mousePointer)) {
      setQuickFireStatus("Waiting for left click");
      return null;
    }

    const bodyX = Number(body.x);
    const bodyY = Number(body.y);
    const pointerWorld = getQuickFirePointerWorld(mousePointer, scene);
    const worldX = Number(pointerWorld?.x);
    const worldY = Number(pointerWorld?.y);
    if (![bodyX, bodyY, worldX, worldY].every(Number.isFinite)) {
      setQuickFireStatus("Waiting for coordinates");
      return null;
    }

    return { angle: Math.atan2(worldY - (bodyY - 3), worldX - bodyX), bodyX, bodyY };
  }

  function refillQuickFirePacketTokens(now, cfg) {
    if (!quickFireState.lastTokenAt) quickFireState.lastTokenAt = now;
    const elapsedSeconds = Math.max(0, (now - quickFireState.lastTokenAt) / 1000);
    quickFireState.lastTokenAt = now;
    quickFireState.packetTokens = Math.min(
      cfg.maxPacketsPerSecond,
      quickFireState.packetTokens + elapsedSeconds * cfg.maxPacketsPerSecond
    );
  }

  function getQuickFireDueCount(now, cfg) {
    if (cfg.fireIntervalMs <= 0) return cfg.maxBurstPerTick;
    if (!quickFireState.nextShotAt) quickFireState.nextShotAt = now;
    if (now < quickFireState.nextShotAt) return 0;
    const catchupMs = Math.min(cfg.maxCatchupMs, now - quickFireState.nextShotAt);
    return 1 + Math.floor(catchupMs / cfg.fireIntervalMs);
  }

  function sendQuickFireBurst(shot, requestedCount, cfg) {
    if (!shot || requestedCount <= 0) return 0;
    const bufferLimit = cfg.socketBufferLimitBytes;
    const bufferedAmount = getQuickFireBufferedAmount();
    if (bufferLimit > 0 && bufferedAmount >= bufferLimit) {
      setQuickFireStatus("Throttled: socket buffer");
      return 0;
    }

    const tokenCount = Math.floor(quickFireState.packetTokens);
    let count = Math.min(requestedCount, cfg.maxBurstPerTick, tokenCount);
    if (count <= 0) {
      setQuickFireStatus("Throttled: rate limit");
      return 0;
    }

    let sent = 0;
    for (; sent < count; sent += 1) {
      if (bufferLimit > 0 && sent > 0 && getQuickFireBufferedAmount() >= bufferLimit) {
        setQuickFireStatus("Throttled: socket buffer");
        break;
      }
      if (!sendQuickFireMessage(shot.angle, shot.bodyX, shot.bodyY)) break;
    }
    quickFireState.packetTokens = Math.max(0, quickFireState.packetTokens - sent);
    if (sent > 0) setQuickFireStatus(sent === 1 ? "Fired" : `Fired x${sent}`);
    return sent;
  }

  function scheduleQuickFireLoop(cfg = normalizeQuickFireConfig(), delayMs = 0) {
    if (!quickFireState.enabled || quickFireState.loopPending) return;
    const delay = Number(delayMs);
    quickFireState.loopPending = true;
    if (Number.isFinite(delay) && delay > 0) {
      quickFireState.timerId = setTimeout(quickFireLoop, Math.min(100, delay));
      return;
    }

    const mode = cfg.schedulerMode === "auto" ? "messageChannel" : cfg.schedulerMode;
    if (mode === "raf") {
      quickFireState.rafId = requestAnimationFrame(quickFireLoop);
      return;
    }
    if (mode === "messageChannel" && typeof MessageChannel === "function") {
      if (!quickFireState.messageChannel) {
        quickFireState.messageChannel = new MessageChannel();
        quickFireState.messageChannel.port1.onmessage = () => quickFireLoop();
      }
      quickFireState.messageChannel.port2.postMessage(0);
      return;
    }
    quickFireState.timerId = setTimeout(quickFireLoop, 0);
  }

  function getQuickFireNextDelay(now, cfg) {
    const tokenShortfall = quickFireState.packetTokens < 1
      ? ((1 - quickFireState.packetTokens) / cfg.maxPacketsPerSecond) * 1000
      : 0;
    const shotDelay = cfg.fireIntervalMs > 0 && quickFireState.nextShotAt > now
      ? quickFireState.nextShotAt - now
      : 0;
    if (tokenShortfall > 0 && shotDelay > 0) return Math.min(tokenShortfall, shotDelay);
    return Math.max(tokenShortfall, shotDelay);
  }

  function quickFireLoop() {
    quickFireState.loopPending = false;
    quickFireState.timerId = null;
    quickFireState.rafId = null;
    if (!quickFireState.enabled) return;

    const now = performance.now();
    const cfg = normalizeQuickFireConfig();
    quickFireState.fireIntervalMs = cfg.fireIntervalMs;
    quickFireState.lastLoopAt = now;
    refillQuickFirePacketTokens(now, cfg);

    const shot = buildQuickFireShot(cfg);
    if (!shot) {
      quickFireState.nextShotAt = cfg.fireIntervalMs > 0 ? now + cfg.fireIntervalMs : now;
      scheduleQuickFireLoop(cfg, 16);
      return;
    }

    const dueCount = getQuickFireDueCount(now, cfg);
    const requestedCount = cfg.fireIntervalMs <= 0 ? cfg.maxBurstPerTick : Math.min(dueCount, cfg.maxBurstPerTick);
    const sent = sendQuickFireBurst(shot, requestedCount, cfg);
    if (cfg.fireIntervalMs > 0 && dueCount > 0) {
      const accountedCount = Math.max(1, sent || requestedCount);
      quickFireState.nextShotAt += accountedCount * cfg.fireIntervalMs;
      const earliestCatchupAt = now - cfg.maxCatchupMs;
      if (quickFireState.nextShotAt < earliestCatchupAt) quickFireState.nextShotAt = earliestCatchupAt;
    } else if (cfg.fireIntervalMs <= 0) {
      quickFireState.nextShotAt = now;
    }

    scheduleQuickFireLoop(cfg, getQuickFireNextDelay(now, cfg));
  }

  function startQuickFire() {
    stopQuickFire();
    quickFireState.enabled = true;
    const cfg = normalizeQuickFireConfig();
    const now = performance.now();
    quickFireState.fireIntervalMs = cfg.fireIntervalMs;
    quickFireState.lastLoopAt = now;
    quickFireState.nextShotAt = now;
    quickFireState.lastTokenAt = now;
    quickFireState.packetTokens = Math.min(cfg.maxBurstPerTick, cfg.maxPacketsPerSecond);
    setQuickFireStatus("Armed");
    scheduleQuickFireLoop(cfg);
  }

  function stopQuickFire() {
    if (quickFireState.timerId != null) {
      clearTimeout(quickFireState.timerId);
      quickFireState.timerId = null;
    }
    if (quickFireState.rafId != null) {
      cancelAnimationFrame(quickFireState.rafId);
      quickFireState.rafId = null;
    }
    if (quickFireState.messageChannel) {
      quickFireState.messageChannel.port1.onmessage = null;
      quickFireState.messageChannel.port1.close?.();
      quickFireState.messageChannel.port2.close?.();
      quickFireState.messageChannel = null;
    }
    quickFireState.loopPending = false;
    quickFireState.enabled = false;
    quickFireState.fireIntervalMs = 5;
    quickFireState.nextShotAt = 0;
    quickFireState.packetTokens = 0;
    quickFireState.lastTokenAt = 0;
    setQuickFireStatus("Idle");
  }

  function triggerAssistTick() {
    if (!triggerAssistState.enabled) return;
    const cfg = getTriggerAssistConfig();
    if (!cfg.enabled) {
      triggerAssistState.statusText = "Disabled in config";
      triggerAssistState.target = null;
      releaseFireHold();
      renderTriggerAssistOverlay(cfg);
      return;
    }
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) {
      triggerAssistState.statusText = "Waiting for focus";
      triggerAssistState.target = null;
      releaseFireHold();
      renderTriggerAssistOverlay(cfg);
      return;
    }

    const target = findTriggerTarget(cfg);
    triggerAssistState.target = target;
    if (!target) {
      const hasShared = window.__anrrgmEspShared?.ready;
      const hasStores = Boolean((espState.stores ?? window.stores)?.phaser?.scene);
      triggerAssistState.statusText = (!hasShared && !hasStores) ? "Waiting for match data" : "No target";
      releaseFireHold();
      renderTriggerAssistOverlay(cfg);
      return;
    }

    triggerAssistState.statusText = `Inside Hitbox: ${target.player?.name ?? "Player"}`;
    const now = Date.now();
    const minDelay = Math.max(16, Number(cfg.fireRateMs) || 45);
    if (cfg.holdToFire) {
      attemptFire(true, false, null);
    } else if (now - triggerAssistState.lastFireAt >= minDelay && attemptFire(false, false, null)) {
      triggerAssistState.lastFireAt = now;
    }

    if (triggerAssistState.releaseTimeoutId != null) clearTimeout(triggerAssistState.releaseTimeoutId);
    triggerAssistState.releaseTimeoutId = setTimeout(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") releaseFireHold();
    }, Math.max(160, minDelay * 2));

    renderTriggerAssistOverlay(cfg);
  }

  function startTriggerAssist() {
    if (triggerAssistState.enabled) return;
    primeSharedPlayerData();
    triggerAssistState.enabled = true;
    createTriggerAssistCanvas();
    triggerAssistState.statusText = "Armed";
    startUnifiedRenderLoop();
  }

  function stopTriggerAssist() {
    if (!triggerAssistState.enabled) return;
    triggerAssistState.enabled = false;
    if (triggerAssistState.releaseTimeoutId != null) {
      clearTimeout(triggerAssistState.releaseTimeoutId);
      triggerAssistState.releaseTimeoutId = null;
    }
    releaseFireHold();
    triggerAssistState.target = null;
    triggerAssistState.statusText = "Idle";
    destroyTriggerAssistCanvas();
    stopUnifiedRenderLoopIfIdle();
  }

  function runTimedModule(key, fn) {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    renderDiagnostics.moduleMs[key] = renderDiagnostics.moduleMs[key] * 0.85 + elapsed * 0.15;
  }

  function unifiedRenderTick(now) {
    if (!unifiedRenderState.running) return;
    if (renderDiagnostics.lastFrameAt > 0) {
      const dt = now - renderDiagnostics.lastFrameAt;
      if (dt > 25) renderDiagnostics.droppedFrames += 1;
    }
    renderDiagnostics.lastFrameAt = now;
    renderDiagnostics.frameCount += 1;

    if (espState.enabled) runTimedModule("esp", renderEspTick);
    if (crosshairState.enabled) runTimedModule("crosshair", renderCrosshairFrame);
    if (autoAimState.enabled) runTimedModule("autoAim", autoAimTick);
    if (triggerAssistState.enabled) runTimedModule("triggerAssist", triggerAssistTick);
    if (cameraZoomState.enabled) runTimedModule("cameraZoom", applyCameraZoomTick);

    unifiedRenderState.rafId = requestAnimationFrame(unifiedRenderTick);
  }

  function startUnifiedRenderLoop() {
    if (unifiedRenderState.running) return;
    unifiedRenderState.running = true;
    unifiedRenderState.rafId = requestAnimationFrame(unifiedRenderTick);
  }

  function stopUnifiedRenderLoopIfIdle() {
    if (espState.enabled || crosshairState.enabled || autoAimState.enabled || triggerAssistState.enabled || cameraZoomState.enabled) return;
    unifiedRenderState.running = false;
    if (unifiedRenderState.rafId != null) {
      cancelAnimationFrame(unifiedRenderState.rafId);
      unifiedRenderState.rafId = null;
    }
  }

  window.addEventListener("blur", () => {
    autoAimInputState.leftMouseDown = false;
    quickFireInputState.leftMouseDown = false;
    autoAimInputState.reroutedShotActive = false;
    autoAimState.target = null;
    releaseFireHold();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      autoAimInputState.leftMouseDown = false;
      quickFireInputState.leftMouseDown = false;
      autoAimInputState.reroutedShotActive = false;
      autoAimState.target = null;
      releaseFireHold();
    }
  });
  window.addEventListener("resize", resizeTriggerAssistCanvas);
  window.addEventListener("resize", resizeAutoAimCanvas);
  function isEventInsideUi(target) {
    const el = target instanceof Element ? target : null;
    return Boolean(el?.closest(".anrrgm-root, .anrrgm-config-backdrop, .anrrgm-settings, .anrrgm-config"));
  }

  function shouldRerouteManualShot(event) {
    if (!event || event.button !== 0) return false;
    if (isEventInsideUi(event.target)) return false;
    if (!autoAimState.enabled || !autoAimState.target) return false;
    if (triggerAssistState.enabled) return false;
    const cfg = getAutoAimConfig();
    if (!cfg.enabled) return false;
    if (cfg.onlyWhenGameFocused && (!document.hasFocus() || document.visibilityState !== "visible")) return false;
    return true;
  }

  window.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !isEventInsideUi(event.target)) quickFireInputState.leftMouseDown = true;
  }, { capture: true, passive: true });
  window.addEventListener("pointerup", (event) => {
    if (event.button === 0) quickFireInputState.leftMouseDown = false;
  }, { capture: true, passive: true });

  window.addEventListener("mousedown", (event) => {
    if (!shouldRerouteManualShot(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    autoAimInputState.leftMouseDown = true;
    quickFireInputState.leftMouseDown = true;
    autoAimInputState.reroutedShotActive = true;
    attemptFire(false, false, { x: crosshairState.mouseX, y: crosshairState.mouseY });
  }, true);

  window.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || isEventInsideUi(event.target)) return;
    if (!autoAimInputState.reroutedShotActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    autoAimInputState.leftMouseDown = false;
    quickFireInputState.leftMouseDown = false;
    autoAimInputState.reroutedShotActive = false;
  }, true);

  window.addEventListener("mousedown", (event) => {
    if (event.button === 0 && !isEventInsideUi(event.target)) {
      autoAimInputState.leftMouseDown = true;
      quickFireInputState.leftMouseDown = true;
    }
  }, { passive: true });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) {
      autoAimInputState.leftMouseDown = false;
      quickFireInputState.leftMouseDown = false;
      autoAimInputState.reroutedShotActive = false;
    }
  }, { passive: true });

  const answerPopupState = {
    enabled: false,
    container: null,
    timeoutId: null,
    lastAnswer: "",
    lastShownAt: 0,
    lastRenderedAnswer: "",
  };
  const drawItAnswerRevealState = {
    enabled: false,
    selectorMode: "auto",
    lastAnswer: "",
    syncIntervalId: null,
  };

  function getAnswerRevealConfig() {
    if (typeof state !== "undefined" && state?.moduleConfig instanceof Map) {
      const saved = state.moduleConfig.get("Answer Reveal");
      if (saved && typeof saved === "object") {
        return {
          selectorMode: saved.selectorMode === "strict" ? "strict" : "auto",
        };
      }
    }
    return { selectorMode: "auto" };
  }

  function findDrawItMaskedTermElement(selectorMode = "auto") {
    const strictSelectors = [
      ".sc-iKrZTU.cVnVFI span",
      ".sc-iKrZTU.cVnVFI",
      "[data-qa='term-mask']",
      "[data-testid='term-mask']",
      "[class*='term'][class*='mask']",
    ];
    const autoSelectors = [
      ...strictSelectors,
      "[class*='word'][class*='mask']",
      "[class*='draw'][class*='term']",
      ".hSIGsV .cVnVFI span",
      ".hSIGsV .cVnVFI",
      "[data-qa*='term']",
      "[data-testid*='term']",
    ];
    const selectors = selectorMode === "strict" ? strictSelectors : autoSelectors;
    for (const selector of selectors) {
      const hit = document.querySelector(selector);
      if (hit && typeof hit.textContent === "string") return hit;
    }
    return null;
  }

  function applyDrawItAnswerReveal(answerText) {
    if (!drawItAnswerRevealState.enabled) return;
    const answer = String(answerText || "").trim();
    if (!answer) return;
    drawItAnswerRevealState.lastAnswer = answer;
    forceDrawItAnswerReveal();
  }

  function forceDrawItAnswerReveal() {
    if (!drawItAnswerRevealState.enabled) return;
    const answer = String(drawItAnswerRevealState.lastAnswer || "").trim();
    if (!answer) return;
    const target = findDrawItMaskedTermElement(drawItAnswerRevealState.selectorMode);
    if (!target) return;
    if (!target.dataset.anrrgmOriginalMask) {
      target.dataset.anrrgmOriginalMask = String(target.textContent || "");
    }
    if (target.textContent !== answer) target.textContent = answer;
  }

  function restoreDrawItAnswerMask() {
    const target = findDrawItMaskedTermElement(drawItAnswerRevealState.selectorMode);
    if (!target) return;
    const originalMask = target.dataset.anrrgmOriginalMask;
    if (typeof originalMask === "string" && originalMask.length) {
      target.textContent = originalMask;
      delete target.dataset.anrrgmOriginalMask;
    }
  }

  function startDrawItAnswerReveal() {
    const cfg = getAnswerRevealConfig();
    drawItAnswerRevealState.selectorMode = cfg.selectorMode;
    drawItAnswerRevealState.enabled = true;
    if (!drawItAnswerRevealState.syncIntervalId) {
      drawItAnswerRevealState.syncIntervalId = setInterval(forceDrawItAnswerReveal, 50);
    }
  }

  function stopDrawItAnswerReveal() {
    drawItAnswerRevealState.enabled = false;
    drawItAnswerRevealState.lastAnswer = "";
    if (drawItAnswerRevealState.syncIntervalId) {
      clearInterval(drawItAnswerRevealState.syncIntervalId);
      drawItAnswerRevealState.syncIntervalId = null;
    }
    restoreDrawItAnswerMask();
  }

  const ANSWER_POPUP_PRESETS = {
    default: { accent: "#ff4a4a", textColor: "#ffffff", durationMs: 2600, panelBg: "rgba(8, 10, 14, 0.92)", headerStart: "rgba(255, 74, 74, 0.30)", headerEnd: "rgba(45, 12, 12, 0.95)" },
    green: { accent: "#2dff75", textColor: "#e8fff1", durationMs: 2400, panelBg: "rgba(7, 20, 12, 0.92)", headerStart: "rgba(45, 255, 117, 0.30)", headerEnd: "rgba(15, 47, 27, 0.95)" },
    ice: { accent: "#6cd8ff", textColor: "#eaf7ff", durationMs: 2400, panelBg: "rgba(8, 17, 24, 0.92)", headerStart: "rgba(108, 216, 255, 0.30)", headerEnd: "rgba(19, 48, 66, 0.95)" },
    midnight: { accent: "#9b5cff", textColor: "#f2eaff", durationMs: 2500, panelBg: "rgba(13, 8, 28, 0.94)", headerStart: "rgba(155, 92, 255, 0.34)", headerEnd: "rgba(34, 13, 64, 0.96)" },
    grayscale: { accent: "#d4d4d4", textColor: "#f1f1f1", durationMs: 2600, panelBg: "rgba(18, 18, 18, 0.92)", headerStart: "rgba(143, 143, 143, 0.30)", headerEnd: "rgba(29, 29, 29, 0.95)" },
  };

  function normalizePopupPresetName(name) {
    const key = String(name || "default").toLowerCase();
    return Object.prototype.hasOwnProperty.call(ANSWER_POPUP_PRESETS, key) ? key : "default";
  }

  function getGlobalPresetName() {
    const name = typeof state !== "undefined" ? state?.globalPreset : "default";
    return normalizePopupPresetName(name || "default");
  }

  function getEffectivePopupPresetName(selectedPresetName) {
    const selected = normalizePopupPresetName(selectedPresetName);
    return selected === "default" ? getGlobalPresetName() : selected;
  }

  function applyAnswerPopupPreset(cfg, presetName) {
    const name = normalizePopupPresetName(presetName);
    const preset = ANSWER_POPUP_PRESETS[getEffectivePopupPresetName(name)] || ANSWER_POPUP_PRESETS.default;
    cfg.preset = name;
    cfg.accent = preset.accent;
    cfg.textColor = preset.textColor;
    cfg.durationMs = preset.durationMs;
  }

  function getAnswerPopupConfig() {
    const defaults = {
      preset: "default",
      text: "answer",
      durationMs: 2600,
      accent: "#ff4a4a",
      textColor: "#ffffff",
    };
    let cfg = defaults;
    if (typeof state !== "undefined" && state?.moduleConfig instanceof Map) {
      const saved = state.moduleConfig.get("Answer Popup");
      if (saved && typeof saved === "object") cfg = { ...defaults, ...saved };
    }
    const selectedPreset = normalizePopupPresetName(cfg.preset || "default");
    const effectivePresetName = getEffectivePopupPresetName(selectedPreset);
    const preset = ANSWER_POPUP_PRESETS[effectivePresetName] || ANSWER_POPUP_PRESETS.default;
    const usePresetOnly = selectedPreset === "default";
    return {
      globalPreset: getGlobalPresetName(),
      preset: selectedPreset,
      effectivePreset: effectivePresetName,
      text: String(cfg.text ?? defaults.text),
      durationMs: Math.max(
        400,
        Number(usePresetOnly ? preset.durationMs : (cfg.durationMs ?? preset.durationMs ?? defaults.durationMs)) || defaults.durationMs,
      ),
      accent: String(usePresetOnly ? preset.accent : (cfg.accent ?? preset.accent ?? defaults.accent)),
      textColor: String(usePresetOnly ? preset.textColor : (cfg.textColor ?? preset.textColor ?? defaults.textColor)),
      panelBg: String(preset.panelBg ?? ANSWER_POPUP_PRESETS.default.panelBg),
      headerStart: String(preset.headerStart ?? ANSWER_POPUP_PRESETS.default.headerStart),
      headerEnd: String(preset.headerEnd ?? ANSWER_POPUP_PRESETS.default.headerEnd),
      headerText: String(usePresetOnly ? preset.textColor : (cfg.textColor ?? preset.textColor ?? defaults.textColor)),
    };
  }

  function ensureAnswerPopupContainer() {
    if (answerPopupState.container?.isConnected) return answerPopupState.container;
    const popup = document.createElement("div");
    popup.className = "anrrgm-answer-popup";
    popup.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:92px",
      "transform:translate(-50%, -18px)",
      "min-width:260px",
      "max-width:min(86vw,640px)",
      "padding:0",
      "border-radius:12px",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif",
      "z-index:2147483647",
      "opacity:0",
      "pointer-events:none",
      "transition:opacity .18s ease, transform .18s ease",
      "box-shadow:0 14px 34px rgba(0,0,0,.45)",
      "border:1px solid rgba(255,255,255,.14)",
      "display:none",
      "overflow:hidden",
      "white-space:normal",
      "overflow-wrap:anywhere",
    ].join(";");
    document.documentElement.appendChild(popup);
    answerPopupState.container = popup;
    return popup;
  }

  function showAnswerPopup(answerText) {
    if (!answerPopupState.enabled) return;
    const answer = String(answerText || "").trim();
    if (!answer) return;
    const now = Date.now();
    if (answer === answerPopupState.lastAnswer && now - answerPopupState.lastShownAt < 700) return;
    answerPopupState.lastAnswer = answer;
    answerPopupState.lastShownAt = now;
    answerPopupState.lastRenderedAnswer = answer;

    const popup = ensureAnswerPopupContainer();
    const cfg = getAnswerPopupConfig();
    popup.style.background = cfg.panelBg;
    popup.style.color = cfg.textColor;
    popup.style.borderLeft = `4px solid ${cfg.accent}`;
    popup.style.border = "1px solid rgba(255,255,255,.14)";
    popup.style.boxShadow = "0 14px 34px rgba(0,0,0,.45)";
    const label = cfg.text.trim();
    popup.innerHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);background:linear-gradient(90deg, ${cfg.headerStart}, ${cfg.headerEnd});color:${cfg.headerText};font-size:13px;font-weight:700;text-transform:capitalize;">${label || "answer"}</div>
      <div style="padding:10px 12px;font-size:16px;font-weight:700;line-height:1.25;"><span style="color:${cfg.accent};">${answer}</span></div>
    `;

    popup.style.display = "block";
    popup.style.opacity = "1";
    popup.style.transform = "translate(-50%, 0)";
    if (answerPopupState.timeoutId) clearTimeout(answerPopupState.timeoutId);
    answerPopupState.timeoutId = setTimeout(() => {
      popup.style.opacity = "0";
      popup.style.transform = "translate(-50%, -18px)";
      setTimeout(() => {
        if (popup.style.opacity === "0") popup.style.display = "none";
      }, 180);
    }, cfg.durationMs);
  }

  function refreshVisibleAnswerPopup() {
    if (!answerPopupState.container) return;
    if (answerPopupState.container.style.display === "none") return;
    const answer = String(answerPopupState.lastRenderedAnswer || "").trim();
    if (!answer) return;
    const cfg = getAnswerPopupConfig();
    answerPopupState.container.style.background = cfg.panelBg;
    answerPopupState.container.style.color = cfg.textColor;
    answerPopupState.container.style.borderLeft = `4px solid ${cfg.accent}`;
    const label = cfg.text.trim();
    answerPopupState.container.innerHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);background:linear-gradient(90deg, ${cfg.headerStart}, ${cfg.headerEnd});color:${cfg.headerText};font-size:13px;font-weight:700;text-transform:capitalize;">${label || "answer"}</div>
      <div style="padding:10px 12px;font-size:16px;font-weight:700;line-height:1.25;"><span style="color:${cfg.accent};">${answer}</span></div>
    `;
  }

  function startAnswerPopup() {
    answerPopupState.enabled = true;
  }

  function stopAnswerPopup() {
    answerPopupState.enabled = false;
    if (answerPopupState.timeoutId) {
      clearTimeout(answerPopupState.timeoutId);
      answerPopupState.timeoutId = null;
    }
    if (answerPopupState.container) {
      answerPopupState.container.style.opacity = "0";
      answerPopupState.container.style.display = "none";
    }
    answerPopupState.lastRenderedAnswer = "";
  }

  const UPGRADE_HUD_LABELS = {
    moneyPerQuestion: "Money Per Question",
    streakBonus: "Streak Bonus",
    multiplier: "Multiplier",
    insurance: "Insurance",
  };
  const UPGRADE_HUD_COSTS_BY_TARGET_LEVEL = {
    moneyPerQuestion: { 2: 10, 3: 100, 4: 1000, 5: 10000, 6: 75000, 7: 300000, 8: 1000000, 9: 10000000, 10: 100000000 },
    streakBonus: { 2: 20, 3: 200, 4: 2000, 5: 20000, 6: 200000, 7: 2000000, 8: 20000000, 9: 200000000, 10: 2000000000 },
    multiplier: { 2: 50, 3: 300, 4: 2000, 5: 12000, 6: 85000, 7: 700000, 8: 6500000, 9: 65000000, 10: 1000000000 },
    insurance: { 2: 10, 3: 250, 4: 1000, 5: 25000, 6: 100000, 7: 1000000, 8: 5000000, 9: 25000000, 10: 500000000 },
  };
  const upgradeHudState = {
    enabled: false,
    container: null,
    config: {
      displayTitle: true,
      showLvlPrefix: false,
      showUpgradeButton: true,
      hudSize: 100,
    },
    levels: {
      moneyPerQuestion: 1,
      streakBonus: 1,
      multiplier: 1,
      insurance: 1,
    },
    balance: 0,
  };
  const UPGRADE_HUD_LOG_PREFIX = "[Upgrade HUD]";
  const AUTO_UPGRADE_LOG_PREFIX = "[Auto Upgrade]";
  const AUTO_UPGRADE_TIE_BREAK_ORDER = ["moneyPerQuestion", "streakBonus", "multiplier", "insurance"];
  const autoUpgradeState = {
    enabled: false,
    intervalId: null,
    toggles: {
      multiplier: true,
      moneyPerQuestion: true,
      streakBonus: true,
      insurance: false,
    },
    order: [...AUTO_UPGRADE_TIE_BREAK_ORDER],
  };
  const UPGRADE_HUD_TOP_OFFSET_PX = 39;

  function upgradeHudLog(message, extra) {
    if (extra === undefined) console.log(`${UPGRADE_HUD_LOG_PREFIX} ${message}`);
    else console.log(`${UPGRADE_HUD_LOG_PREFIX} ${message}`, extra);
  }

  function isRememberHudPositionEnabled(value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return true;
  }

  function parseBooleanSetting(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return Boolean(value);
  }

  function normalizeHudPosition(pos, fallback = null) {
    const normalizePoint = (value) => {
      if (!value || typeof value !== "object") return null;
      const rawX = value.x ?? value.left ?? value.hudPositionX;
      const rawY = value.y ?? value.top ?? value.hudPositionY;
      const x = Number.parseFloat(rawX);
      const y = Number.parseFloat(rawY);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      return null;
    };
    return normalizePoint(pos) || normalizePoint(fallback) || null;
  }


  function readModuleConfigFromStorage(moduleName) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      const moduleConfig = Array.isArray(saved?.moduleConfig) ? saved.moduleConfig : [];
      for (const entry of moduleConfig) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        if (entry[0] !== moduleName) continue;
        const cfg = entry[1];
        if (cfg && typeof cfg === "object") return { ...cfg };
        break;
      }
    } catch (_) {}
    return null;
  }

  function readHudPositionFromStorage(moduleName, fallback = null) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return normalizeHudPosition(null, fallback);
      const saved = JSON.parse(raw);
      const moduleConfig = Array.isArray(saved?.moduleConfig) ? saved.moduleConfig : [];
      for (const entry of moduleConfig) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        if (entry[0] !== moduleName) continue;
        const cfg = entry[1] && typeof entry[1] === "object" ? entry[1] : null;
        if (!cfg) break;
        const legacy = { x: cfg.hudPositionX, y: cfg.hudPositionY, left: cfg.left, top: cfg.top };
        return normalizeHudPosition(cfg.hudPosition, legacy || fallback);
      }
    } catch (_) {}
    return normalizeHudPosition(null, fallback);
  }

  function readHudPosition(moduleName, fallback = null) {
    const cfg = getHudModuleConfigObject(moduleName, {});
    const legacy = cfg && typeof cfg === "object"
      ? { x: cfg.hudPositionX, y: cfg.hudPositionY, left: cfg.left, top: cfg.top }
      : null;
    const fromCfg = normalizeHudPosition(cfg?.hudPosition, legacy || null);
    if (fromCfg) return fromCfg;
    return readHudPositionFromStorage(moduleName, fallback);
  }

  function persistHudPositionToStorage(moduleName, hudPosition) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const moduleConfig = Array.isArray(saved?.moduleConfig) ? saved.moduleConfig.slice() : [];
      let found = false;
      for (let i = 0; i < moduleConfig.length; i += 1) {
        const entry = moduleConfig[i];
        if (!Array.isArray(entry) || entry.length < 2) continue;
        if (entry[0] !== moduleName) continue;
        const cfg = entry[1] && typeof entry[1] === "object" ? { ...entry[1] } : {};
        cfg.hudPosition = { x: Math.round(Number(hudPosition.x) || 0), y: Math.round(Number(hudPosition.y) || 0) };
        moduleConfig[i] = [entry[0], cfg];
        found = true;
        break;
      }
      if (!found) moduleConfig.push([moduleName, { keybind: null, hudPosition: { x: Math.round(Number(hudPosition.x) || 0), y: Math.round(Number(hudPosition.y) || 0) } }]);
      saved.moduleConfig = moduleConfig;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      console.log("[HUD Position] Forced localStorage sync", { moduleName, hudPosition: { x: Math.round(Number(hudPosition.x) || 0), y: Math.round(Number(hudPosition.y) || 0) } });
    } catch (_) {}
  }

  function writeHudPosition(moduleName, pos) {
    const normalized = normalizeHudPosition(pos, null);
    if (!normalized) return null;
    const cfg = getHudModuleConfigObject(moduleName, {});
    if (!cfg || typeof cfg !== "object") return null;
    cfg.hudPosition = { x: Math.round(normalized.x), y: Math.round(normalized.y) };
    console.log("[HUD Position] Stored", { moduleName, hudPosition: { ...cfg.hudPosition } });
    persistHudPositionToStorage(moduleName, cfg.hudPosition);
    markHudFallbackConfigDirty(moduleName);
    if (typeof saveSettings === "function") saveSettings();
    return { ...cfg.hudPosition };
  }

  function readHudPositionFromElement(el) {
    if (!el) return null;
    const left = Number.parseFloat(el.style.left || "");
    const top = Number.parseFloat(el.style.top || "");
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { x: left, y: top };
  }

  function applyHudPosition(el, pos, clamp = true) {
    if (!el || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, rect.width || el.offsetWidth || 1);
    const height = Math.max(1, rect.height || el.offsetHeight || 1);
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    const next = clamp
      ? { x: Math.max(0, Math.min(maxX, Number(pos.x) || 0)), y: Math.max(0, Math.min(maxY, Number(pos.y) || 0)) }
      : { x: Number(pos.x) || 0, y: Number(pos.y) || 0 };
    el.style.removeProperty("right");
    el.style.removeProperty("bottom");
    el.style.setProperty("left", `${next.x}px`);
    el.style.setProperty("top", `${next.y}px`);
    return next;
  }



  function markHudFallbackConfigDirty(moduleName) {
    const dirtyKey = "__anrrgmHudFallbackConfigDirty";
    if (!window[dirtyKey] || typeof window[dirtyKey] !== "object") window[dirtyKey] = {};
    window[dirtyKey][moduleName] = true;
  }

  function getHudModuleConfigObject(moduleName, defaults = {}) {
    const cacheKey = "__anrrgmHudFallbackConfig";
    const dirtyKey = "__anrrgmHudFallbackConfigDirty";
    if (!window[cacheKey] || typeof window[cacheKey] !== "object") window[cacheKey] = {};
    if (!window[dirtyKey] || typeof window[dirtyKey] !== "object") window[dirtyKey] = {};

    try {
      if (typeof moduleCfg === "function") {
        const cfg = moduleCfg(moduleName);
        if (cfg && typeof cfg === "object") {
          const fallbackCfg = window[cacheKey][moduleName];
          const fallbackDirty = window[dirtyKey][moduleName] === true;
          if (fallbackCfg && typeof fallbackCfg === "object") {
            if (fallbackDirty) {
              for (const [key, value] of Object.entries(fallbackCfg)) cfg[key] = value;
            }
            delete window[cacheKey][moduleName];
            delete window[dirtyKey][moduleName];
          }
          return cfg;
        }
      }
    } catch (_) {}

    if (!window[cacheKey][moduleName] || typeof window[cacheKey][moduleName] !== "object") {
      window[cacheKey][moduleName] = { ...defaults, ...(readModuleConfigFromStorage(moduleName) || {}) };
    }
    return window[cacheKey][moduleName];
  }

  function normalizeUpgradeHudConfigFromRaw(rawCfg = {}) {
    const defaults = { displayTitle: true, showLvlPrefix: false, showUpgradeButton: true, hudSize: 100, hudPosition: null };
    return {
      displayTitle: parseBooleanSetting(rawCfg.displayTitle, defaults.displayTitle),
      showLvlPrefix: parseBooleanSetting(rawCfg.showLvlPrefix, defaults.showLvlPrefix),
      showUpgradeButton: parseBooleanSetting(rawCfg.showUpgradeButton, defaults.showUpgradeButton),
      hudSize: Number.isFinite(Number(rawCfg.hudSize)) ? Math.max(60, Math.min(180, Number(rawCfg.hudSize))) : defaults.hudSize,
      hudPosition: normalizeHudPosition(rawCfg.hudPosition, defaults.hudPosition),
    };
  }

  function normalizeBuildingHudConfigFromRaw(rawCfg = {}) {
    const defaults = { displayTitle: true, hudSize: 100, hudPosition: null };
    return {
      displayTitle: parseBooleanSetting(rawCfg.displayTitle, defaults.displayTitle),
      hudSize: Number.isFinite(Number(rawCfg.hudSize)) ? Math.max(60, Math.min(180, Number(rawCfg.hudSize))) : defaults.hudSize,
      hudPosition: normalizeHudPosition(rawCfg.hudPosition, defaults.hudPosition),
    };
  }

  function readUpgradeHudConfig() {
    const cfg = getHudModuleConfigObject("Upgrade HUD", { displayTitle: true, showLvlPrefix: false, showUpgradeButton: true, hudSize: 100, hudPosition: null });
    const normalized = normalizeUpgradeHudConfigFromRaw(cfg);
    Object.assign(upgradeHudState.config, normalized);
    return { ...normalized };
  }

  function writeUpgradeHudConfigPatch(patch = {}) {
    const cfg = getHudModuleConfigObject("Upgrade HUD", { displayTitle: true, showLvlPrefix: false, showUpgradeButton: true, hudSize: 100, hudPosition: null });
    if (!cfg || typeof cfg !== "object") return readUpgradeHudConfig();
    Object.assign(cfg, patch);
    markHudFallbackConfigDirty("Building HUD");
    markHudFallbackConfigDirty("Upgrade HUD");
    const normalized = normalizeUpgradeHudConfigFromRaw(cfg);
    Object.assign(cfg, normalized);
    Object.assign(upgradeHudState.config, normalized);
    if (typeof saveSettings === "function") saveSettings();
    return { ...normalized };
  }

  function readBuildingHudConfig() {
    const cfg = getHudModuleConfigObject("Building HUD", { displayTitle: true, hudSize: 100, hudPosition: null });
    const normalized = normalizeBuildingHudConfigFromRaw(cfg);
    Object.assign(lavaBuildingHudState.config, normalized);
    return { ...normalized };
  }

  function writeBuildingHudConfigPatch(patch = {}) {
    const cfg = getHudModuleConfigObject("Building HUD", { displayTitle: true, hudSize: 100, hudPosition: null });
    if (!cfg || typeof cfg !== "object") return readBuildingHudConfig();
    Object.assign(cfg, patch);
    const normalized = normalizeBuildingHudConfigFromRaw(cfg);
    Object.assign(cfg, normalized);
    Object.assign(lavaBuildingHudState.config, normalized);
    if (typeof saveSettings === "function") saveSettings();
    return { ...normalized };
  }

  function ensureUpgradeHudContainer() {
    if (upgradeHudState.container?.isConnected) return upgradeHudState.container;
    if (!document.getElementById("anrrgm-upgrade-hud-style")) {
      const style = document.createElement("style");
      style.id = "anrrgm-upgrade-hud-style";
      style.textContent = `
        .anrrgm-upgrade-hud-button:hover:not(:disabled) {
          outline: 2px solid rgba(255,255,255,.95);
          outline-offset: 1px;
        }
      `;
      document.documentElement.appendChild(style);
    }
    const hud = document.createElement("div");
    hud.className = "anrrgm-upgrade-hud";
    hud.style.cssText = [
      "position:fixed",
      `top:${UPGRADE_HUD_TOP_OFFSET_PX}px`,
      "right:14px",
      "min-width:220px",
      "max-width:min(38vw,360px)",
      "padding:10px 12px",
      "border-radius:10px",
      "background:rgba(8,12,17,.88)",
      "border:1px solid rgba(255,255,255,.14)",
      "box-shadow:0 12px 30px rgba(0,0,0,.42)",
      "z-index:2147483646",
      "color:#fff",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif",
      "display:none",
      "pointer-events:auto",
      "cursor:grab",
      "user-select:none",
    ].join(";");
    let dragState = null;
    const clampToViewport = (nextX, nextY) => {
      const rect = hud.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - rect.width);
      const maxY = Math.max(0, window.innerHeight - rect.height);
      return {
        x: Math.max(0, Math.min(maxX, Number(nextX) || 0)),
        y: Math.max(0, Math.min(maxY, Number(nextY) || 0)),
      };
    };
    const handleMouseMove = (event) => {
      if (!dragState) return;
      const nextX = event.clientX - dragState.offsetX;
      const nextY = event.clientY - dragState.offsetY;
      const clamped = clampToViewport(nextX, nextY);
      applyHudPosition(hud, clamped, false);
      writeUpgradeHudConfigPatch({ hudPosition: { x: Math.round(clamped.x), y: Math.round(clamped.y) } });
    };
    const handleDragEnd = () => {
      if (!dragState) return;
      const rect = hud.getBoundingClientRect();
      const clamped = clampToViewport(rect.left, rect.top);
      writeHudPosition("Upgrade HUD", { x: Math.round(clamped.x), y: Math.round(clamped.y) });
      if (typeof saveSettings === "function") saveSettings();
      dragState = null;
      hud.style.cursor = "grab";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleDragEnd);
      window.removeEventListener("blur", handleDragEnd);
      document.removeEventListener("mouseleave", handleDragEnd);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") handleDragEnd();
    };
    hud.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const rect = hud.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      hud.style.cursor = "grabbing";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleDragEnd);
      window.addEventListener("blur", handleDragEnd);
      document.addEventListener("mouseleave", handleDragEnd);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      event.preventDefault();
    });
    const savedPos = readHudPosition("Upgrade HUD", null);
    if (savedPos) {
      const applied = applyHudPosition(hud, savedPos, true);
      upgradeHudLog("Restored HUD position", { moduleName: "Upgrade HUD", saved: savedPos, applied });
    } else {
      upgradeHudLog("No saved HUD position found; using default anchor", { moduleName: "Upgrade HUD", rawCfg: (() => { try { return moduleCfg("Upgrade HUD"); } catch (_) { return null; } })(), storagePos: readHudPositionFromStorage("Upgrade HUD", null) });
    }
    document.documentElement.appendChild(hud);
    upgradeHudState.container = hud;
    return hud;
  }

  function getUpgradeHudConfig() {
    return readUpgradeHudConfig();
  }

  function getLavaBuildingHudConfig() {
    return readBuildingHudConfig();
  }

  function applyUpgradeHudPosition(hud, cfg, moduleName = "Upgrade HUD") {
    const storedPos = readHudPosition(moduleName, null);
    const sourcePos = normalizeHudPosition(storedPos, cfg?.hudPosition);
    if (sourcePos) {
      const applied = applyHudPosition(hud, sourcePos, true);
      upgradeHudLog(`Position source=${storedPos ? "moduleCfg" : "runtime"}`, { moduleName, requested: sourcePos, applied });
      return applied;
    }
    upgradeHudLog("Position source=default-anchor", { moduleName });
    hud.style.removeProperty("top");
    hud.style.removeProperty("right");
    hud.style.removeProperty("bottom");
    hud.style.removeProperty("left");
    hud.style.setProperty("top", `${UPGRADE_HUD_TOP_OFFSET_PX}px`);
    hud.style.setProperty("right", "14px");
    const width = Math.max(1, hud.offsetWidth || hud.getBoundingClientRect().width || 220);
    const anchored = { x: Math.max(0, window.innerWidth - width - 14), y: UPGRADE_HUD_TOP_OFFSET_PX };
    const applied = applyHudPosition(hud, anchored, true);
    return applied;
  }

  function renderUpgradeHud(configOverride = null) {
    const hud = ensureUpgradeHudContainer();
    const cfg = { ...getUpgradeHudConfig(), ...(configOverride && typeof configOverride === "object" ? configOverride : {}) };
    if (!normalizeHudPosition(cfg.hudPosition, null)) {
      const livePos = readHudPositionFromElement(hud);
      if (livePos) {
        writeHudPosition("Upgrade HUD", livePos);
        cfg.hudPosition = livePos;
      }
    }
    const sizeScale = Math.max(0.6, Math.min(1.8, Number(cfg.hudSize || 100) / 100));
    hud.style.minWidth = `${Math.round(220 * sizeScale)}px`;
    hud.style.padding = `${Math.round(10 * sizeScale)}px ${Math.round(12 * sizeScale)}px`;
    hud.style.borderRadius = `${Math.round(10 * sizeScale)}px`;
    const appliedPos = applyUpgradeHudPosition(hud, cfg, "Upgrade HUD");
    if (appliedPos) writeHudPosition("Upgrade HUD", appliedPos);
    const rows = Object.keys(UPGRADE_HUD_LABELS)
      .map((key) => {
        const label = UPGRADE_HUD_LABELS[key];
        const level = Number(upgradeHudState.levels[key]) || 1;
        const levelText = cfg.showLvlPrefix ? `Lvl ${level}` : `${level}`;
        const nextLevel = level + 1;
        const nextCost = UPGRADE_HUD_COSTS_BY_TARGET_LEVEL[key]?.[nextLevel];
        const canAfford = Number.isFinite(nextCost) && Number(upgradeHudState.balance) >= nextCost;
        const isMaxed = !Number.isFinite(nextCost);
        const costText = isMaxed ? "MAX" : `$${Number(nextCost).toLocaleString()}`;
        const buttonBg = isMaxed ? "rgba(255,255,255,.09)" : (canAfford ? "rgba(46,204,113,.35)" : "rgba(255,255,255,.09)");
        const buttonBorder = isMaxed ? "rgba(255,255,255,.24)" : (canAfford ? "rgba(46,204,113,.82)" : "rgba(255,255,255,.24)");
        const buttonColor = isMaxed ? "rgba(255,255,255,.55)" : "#fff";
        const buttonHtml = cfg.showUpgradeButton
          ? `<button class="anrrgm-upgrade-hud-button" data-upgrade-key="${key}" data-upgrade-cost="${isMaxed ? "" : nextCost}" ${isMaxed ? "disabled" : ""} style="appearance:none;border:1px solid ${buttonBorder};background:${buttonBg};color:${buttonColor};border-radius:${Math.max(5, Math.round(6 * sizeScale))}px;padding:${Math.max(2, Math.round(3 * sizeScale))}px ${Math.max(6, Math.round(8 * sizeScale))}px;font-size:${Math.max(10, Math.round(11 * sizeScale))}px;font-weight:700;line-height:1;cursor:${isMaxed ? "default" : "pointer"};min-width:${Math.max(62, Math.round(72 * sizeScale))}px;text-align:center;">${costText}</button>`
          : "";
        return `<div style="display:grid;grid-template-columns:minmax(0,1fr) ${Math.max(28, Math.round(34 * sizeScale))}px auto;align-items:center;column-gap:${Math.round(10 * sizeScale)}px;padding:${Math.max(1, Math.round(2 * sizeScale))}px 0;font-size:${Math.max(11, Math.round(13 * sizeScale))}px;"><span style="opacity:.88;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span><b style="text-align:right;">${levelText}</b>${buttonHtml || '<span></span>'}</div>`;
      })
      .join("");
    const titleRow = cfg.displayTitle
      ? `<div style="font-size:${Math.max(10, Math.round(12 * sizeScale))}px;text-transform:uppercase;letter-spacing:.05em;opacity:.72;margin-bottom:${Math.max(4, Math.round(6 * sizeScale))}px;">Upgrades</div>`
      : "";
    hud.innerHTML = `${titleRow}${rows}`;
    if (cfg.showUpgradeButton) {
      const buttons = hud.querySelectorAll(".anrrgm-upgrade-hud-button");
      for (const button of buttons) {
        button.addEventListener("mousedown", (event) => {
          event.stopPropagation();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const key = String(button.getAttribute("data-upgrade-key") || "");
          if (!key || !UPGRADE_HUD_LABELS[key]) return;
          const cost = Number(button.getAttribute("data-upgrade-cost"));
          if (Number.isFinite(cost) && Number(upgradeHudState.balance) < cost) return;
          const currentLevel = Number(upgradeHudState.levels[key]) || 1;
          const nextLevel = currentLevel + 1;
          const sent = sendUpgradePurchase(key, nextLevel);
          if (sent) upgradeHudLog("Sent UPGRADE_PURCHASED", { key, nextLevel });
        });
      }
    }
    hud.style.display = upgradeHudState.enabled ? "block" : "none";
  }

  function hardRefreshUpgradeHud(configOverride = null) {
    if (upgradeHudState.container?.isConnected) upgradeHudState.container.remove();
    upgradeHudState.container = null;
    renderUpgradeHud(configOverride);
  }

  function extractUpgradeLevelsFromStateUpdate(stateUpdate) {
    const tryReadLevels = (entry) => {
      if (!entry || typeof entry !== "object") return null;
      if (entry.type === "UPGRADE_LEVELS" && entry.value && typeof entry.value === "object") return entry.value;
      return null;
    };

    const direct = tryReadLevels(stateUpdate);
    if (direct) return direct;

    if (Array.isArray(stateUpdate)) {
      for (const entry of stateUpdate) {
        const levels = tryReadLevels(entry);
        if (levels) return levels;
      }
    }

    if (stateUpdate && typeof stateUpdate === "object") {
      const nested = tryReadLevels(stateUpdate.data);
      if (nested) return nested;
      const payloadNested = tryReadLevels(stateUpdate.payload?.data);
      if (payloadNested) return payloadNested;
    }

    return null;
  }

  function extractBalanceFromStateUpdate(stateUpdate) {
    const tryReadBalance = (entry) => {
      if (!entry || typeof entry !== "object") return null;
      if (entry.type !== "BALANCE") return null;
      const parsed = Number(entry.value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const direct = tryReadBalance(stateUpdate);
    if (direct != null) return direct;

    if (Array.isArray(stateUpdate)) {
      for (const entry of stateUpdate) {
        const balance = extractBalanceFromStateUpdate(entry);
        if (balance != null) return balance;
      }
    }

    if (stateUpdate && typeof stateUpdate === "object") {
      const nested = tryReadBalance(stateUpdate.data);
      if (nested != null) return nested;
      const payloadNested = tryReadBalance(stateUpdate.payload?.data);
      if (payloadNested != null) return payloadNested;
    }

    return null;
  }

  function updateUpgradeHudLevels(nextLevels) {
    if (!nextLevels || typeof nextLevels !== "object") return;
    const before = { ...upgradeHudState.levels };
    for (const key of Object.keys(UPGRADE_HUD_LABELS)) {
      if (typeof nextLevels[key] === "undefined") continue;
      const n = Number(nextLevels[key]);
      upgradeHudState.levels[key] = Number.isFinite(n) ? n : 1;
    }
    upgradeHudLog("Applied UPGRADE_LEVELS update", { before, incoming: nextLevels, after: { ...upgradeHudState.levels } });
    if (upgradeHudState.enabled) renderUpgradeHud();
  }

  function updateUpgradeHudBalance(nextBalance) {
    const parsed = Number(nextBalance);
    if (!Number.isFinite(parsed)) return;
    upgradeHudState.balance = parsed;
    if (upgradeHudState.enabled) renderUpgradeHud();
  }

  function startUpgradeHud() {
    upgradeHudState.enabled = true;
    upgradeHudLog("Enabled");
    renderUpgradeHud();
  }

  function stopUpgradeHud() {
    upgradeHudState.enabled = false;
    upgradeHudLog("Disabled");
    if (upgradeHudState.container) {
      upgradeHudState.container.style.display = "none";
    }
  }


  function autoUpgradeLog(message, extra) {
    if (extra === undefined) console.log(`${AUTO_UPGRADE_LOG_PREFIX} ${message}`);
    else console.log(`${AUTO_UPGRADE_LOG_PREFIX} ${message}`, extra);
  }


  function getAutoUpgradeConfig() {
    const defaults = { ...autoUpgradeState.toggles };
    const defaultOrder = [...AUTO_UPGRADE_TIE_BREAK_ORDER];
    const parseToggle = (value, fallback) => {
      if (value === undefined || value === null) return fallback;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value === 1;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
        if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
      }
      return false;
    };
    try {
      const cfg = getModuleConfigSafe("Auto Upgrade");
      const resolved = {
        multiplier: parseToggle(cfg.multiplier, defaults.multiplier),
        moneyPerQuestion: parseToggle(cfg.moneyPerQuestion, defaults.moneyPerQuestion),
        streakBonus: parseToggle(cfg.streakBonus, defaults.streakBonus),
        insurance: parseToggle(cfg.insurance, defaults.insurance),
      };
      const configuredOrder = Array.isArray(cfg.order) ? cfg.order.filter((key) => defaultOrder.includes(key)) : [];
      const normalizedOrder = [...configuredOrder];
      for (const key of defaultOrder) if (!normalizedOrder.includes(key)) normalizedOrder.push(key);
      autoUpgradeState.toggles = { ...resolved };
      autoUpgradeState.order = normalizedOrder;
      return resolved;
    } catch (_) {
      autoUpgradeState.order = [...defaultOrder];
      return { ...defaults };
    }
  }

  function getAutoUpgradeSelection() {
    const balance = Number(upgradeHudState.balance);
    if (!Number.isFinite(balance) || balance <= 0) return null;

    const cfg = getAutoUpgradeConfig();
    const candidates = [];
    for (const key of Object.keys(UPGRADE_HUD_LABELS)) {
      if (cfg[key] !== true) continue;
      const level = Number(upgradeHudState.levels[key]) || 1;
      const nextLevel = level + 1;
      const cost = Number(UPGRADE_HUD_COSTS_BY_TARGET_LEVEL[key]?.[nextLevel]);
      if (!Number.isFinite(cost) || cost > balance) continue;
      candidates.push({ key, level, nextLevel, cost });
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost - b.cost;
      return autoUpgradeState.order.indexOf(a.key) - autoUpgradeState.order.indexOf(b.key);
    });

    return candidates[0] || null;
  }

  function sendUpgradePacketForCategory(key, nextLevel) {
    const payload = { upgradeName: UPGRADE_HUD_LABELS[key], level: nextLevel };
    const roomId = socketManager?.blueboatRoomId;
    const socket = socketManager?.socket;
    if (socket && roomId) {
      const encoded = blueboat.encode("UPGRADE_PURCHASED", payload, roomId);
      socket.send(encoded);
      return true;
    }
    socketManager.sendMessage("UPGRADE_PURCHASED", payload);
    return true;
  }

  function sendMultiplierUpgrade(nextLevel) {
    if (autoUpgradeState.toggles.multiplier !== true) return false;
    return sendUpgradePacketForCategory("multiplier", nextLevel);
  }

  function sendMoneyPerQuestionUpgrade(nextLevel) {
    if (autoUpgradeState.toggles.moneyPerQuestion !== true) return false;
    return sendUpgradePacketForCategory("moneyPerQuestion", nextLevel);
  }

  function sendStreakBonusUpgrade(nextLevel) {
    if (autoUpgradeState.toggles.streakBonus !== true) return false;
    return sendUpgradePacketForCategory("streakBonus", nextLevel);
  }

  function sendInsuranceUpgrade(nextLevel) {
    if (autoUpgradeState.toggles.insurance !== true) return false;
    return sendUpgradePacketForCategory("insurance", nextLevel);
  }

  function sendUpgradePurchase(key, nextLevel, source = "manual") {
    if (!key || !UPGRADE_HUD_LABELS[key]) return false;
    if (source === "auto") {
      if (autoUpgradeState.toggles[key] !== true) {
        autoUpgradeLog("Skipped disabled upgrade category", { key, nextLevel });
        return false;
      }
    }

    if (key === "multiplier") return sendMultiplierUpgrade(nextLevel);
    if (key === "moneyPerQuestion") return sendMoneyPerQuestionUpgrade(nextLevel);
    if (key === "streakBonus") return sendStreakBonusUpgrade(nextLevel);
    if (key === "insurance") return sendInsuranceUpgrade(nextLevel);
    return false;
  }

  function tickAutoUpgrade() {
    if (!autoUpgradeState.enabled) return;
    getAutoUpgradeConfig();
    const selection = getAutoUpgradeSelection();
    if (!selection) return;
    const sent = sendUpgradePurchase(selection.key, selection.nextLevel, "auto");
    if (sent) autoUpgradeLog("Purchased cheapest available upgrade", selection);
  }

  function startAutoUpgrade() {
    autoUpgradeState.enabled = true;
    getAutoUpgradeConfig();
    if (autoUpgradeState.intervalId) clearInterval(autoUpgradeState.intervalId);
    autoUpgradeState.intervalId = setInterval(tickAutoUpgrade, 150);
    autoUpgradeLog("Enabled");
  }

  function stopAutoUpgrade() {
    autoUpgradeState.enabled = false;
    if (autoUpgradeState.intervalId) {
      clearInterval(autoUpgradeState.intervalId);
      autoUpgradeState.intervalId = null;
    }
    autoUpgradeLog("Disabled");
  }


  const LAVA_BUILDING_OPTIONS = [
    { label: "Plank", cost: 5, packetType: "plank" },
    { label: "Brick", cost: 50, packetType: "brick" },
    { label: "Staircase", cost: 500, packetType: "wall" },
    { label: "House", cost: 5000, packetType: "house" },
    { label: "Shopping Mall", cost: 50000, packetType: "shoppingMall" },
    { label: "Skyscraper", cost: 500000, packetType: "skyscaper" },
    { label: "Mountain", cost: 5000000, packetType: "mountain" },
    { label: "Space Elevator", cost: 50000000, packetType: "spaceElevator" },
  ];

  function sendLavaBuildingPurchase(packetType) {
    if (!packetType) return false;
    const payload = { type: packetType };
    const roomId = socketManager?.blueboatRoomId;
    const socket = socketManager?.socket;
    if (socket && roomId) {
      const encoded = blueboat.encode("LAVA_PURCHASE_PIECE", payload, roomId);
      socket.send(encoded);
      return true;
    }
    socketManager.sendMessage("LAVA_PURCHASE_PIECE", payload);
    return true;
  }

  function ensureLavaBuildingHudContainer() {
    if (lavaBuildingHudState.container?.isConnected) return lavaBuildingHudState.container;
    const hud = document.createElement("div");
    hud.className = "anrrgm-upgrade-hud";
    hud.style.cssText = "position:fixed;top:39px;right:14px;min-width:220px;max-width:min(38vw,360px);padding:10px 12px;border-radius:10px;background:rgba(8,12,17,.88);border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 30px rgba(0,0,0,.42);z-index:2147483646;color:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;display:none;pointer-events:auto;cursor:grab;user-select:none;";
    let dragState = null;
    const clampToViewport = (nextX, nextY) => {
      const rect = hud.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - rect.width);
      const maxY = Math.max(0, window.innerHeight - rect.height);
      return { x: Math.max(0, Math.min(maxX, Number(nextX) || 0)), y: Math.max(0, Math.min(maxY, Number(nextY) || 0)) };
    };
    const handleMouseMove = (event) => {
      if (!dragState) return;
      const clamped = clampToViewport(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
      applyHudPosition(hud, clamped, false);
      writeBuildingHudConfigPatch({ hudPosition: { x: Math.round(clamped.x), y: Math.round(clamped.y) } });
    };
    const handleDragEnd = () => {
      if (!dragState) return;
      const rect = hud.getBoundingClientRect();
      const clamped = clampToViewport(rect.left, rect.top);
      writeHudPosition("Building HUD", { x: Math.round(clamped.x), y: Math.round(clamped.y) });
      if (typeof saveSettings === "function") saveSettings();
      dragState = null;
      hud.style.cursor = "grab";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleDragEnd);
      window.removeEventListener("blur", handleDragEnd);
      document.removeEventListener("mouseleave", handleDragEnd);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") handleDragEnd();
    };
    hud.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const rect = hud.getBoundingClientRect();
      dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      hud.style.cursor = "grabbing";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleDragEnd);
      window.addEventListener("blur", handleDragEnd);
      document.addEventListener("mouseleave", handleDragEnd);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      event.preventDefault();
    });
    const savedPos = readHudPosition("Building HUD", null);
    if (savedPos) {
      const applied = applyHudPosition(hud, savedPos, true);
      upgradeHudLog("Restored HUD position", { moduleName: "Building HUD", saved: savedPos, applied });
    } else {
      upgradeHudLog("No saved HUD position found; using default anchor", { moduleName: "Building HUD", rawCfg: (() => { try { return moduleCfg("Building HUD"); } catch (_) { return null; } })(), storagePos: readHudPositionFromStorage("Building HUD", null) });
    }
    document.documentElement.appendChild(hud);
    lavaBuildingHudState.container = hud;
    return hud;
  }

  function renderLavaBuildingHud(configOverride = null) {
    const hud = ensureLavaBuildingHudContainer();
    const cfg = { ...getLavaBuildingHudConfig(), ...(configOverride && typeof configOverride === "object" ? configOverride : {}) };
    if (!normalizeHudPosition(cfg.hudPosition, null)) {
      const livePos = readHudPositionFromElement(hud);
      if (livePos) {
        writeHudPosition("Building HUD", livePos);
        cfg.hudPosition = livePos;
      }
    }
    const sizeScale = Math.max(0.6, Math.min(1.8, Number(cfg.hudSize || 100) / 100));
    hud.style.minWidth = `${Math.round(220 * sizeScale)}px`;
    hud.style.padding = `${Math.round(10 * sizeScale)}px ${Math.round(12 * sizeScale)}px`;
    hud.style.borderRadius = `${Math.round(10 * sizeScale)}px`;
    const appliedPos = applyUpgradeHudPosition(hud, cfg, "Building HUD");
    if (appliedPos) writeHudPosition("Building HUD", appliedPos);

    const titleRow = cfg.displayTitle !== false
      ? `<div style="font-size:${Math.max(10, Math.round(12 * sizeScale))}px;text-transform:uppercase;letter-spacing:.05em;opacity:.72;margin-bottom:${Math.max(4, Math.round(6 * sizeScale))}px;">Buildings</div>`
      : "";
    const rows = LAVA_BUILDING_OPTIONS.map((build) => {
      const canAfford = lavaBuildingHudState.balance >= build.cost;
      return `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:${Math.round(10 * sizeScale)}px;padding:${Math.max(1, Math.round(2 * sizeScale))}px 0;font-size:${Math.max(11, Math.round(13 * sizeScale))}px;"><span style="opacity:.88;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${build.label}</span><button class="anrrgm-upgrade-hud-button" data-lava-type="${build.packetType}" ${canAfford ? "" : "disabled"} style="appearance:none;border:1px solid ${canAfford ? "rgba(46,204,113,.82)" : "rgba(255,255,255,.24)"};background:${canAfford ? "rgba(46,204,113,.35)" : "rgba(255,255,255,.09)"};color:#fff;border-radius:${Math.max(5, Math.round(6 * sizeScale))}px;padding:${Math.max(2, Math.round(3 * sizeScale))}px ${Math.max(6, Math.round(8 * sizeScale))}px;font-size:${Math.max(10, Math.round(11 * sizeScale))}px;font-weight:700;line-height:1;cursor:${canAfford ? "pointer" : "default"};min-width:${Math.max(62, Math.round(72 * sizeScale))}px;text-align:center;">$${build.cost.toLocaleString()}</button></div>`;
    }).join("");
    hud.innerHTML = `${titleRow}${rows}`;
    for (const button of hud.querySelectorAll("[data-lava-type]")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const packetType = String(button.getAttribute("data-lava-type") || "");
        sendLavaBuildingPurchase(packetType);
      });
    }
    hud.style.display = lavaBuildingHudState.enabled ? "block" : "none";
  }

  function hardRefreshLavaBuildingHud(configOverride = null) {
    if (lavaBuildingHudState.container?.isConnected) lavaBuildingHudState.container.remove();
    lavaBuildingHudState.container = null;
    renderLavaBuildingHud(configOverride);
  }

  function startLavaBuildingHud() {
    lavaBuildingHudState.enabled = true;
    const hud = ensureLavaBuildingHudContainer();
    hud.style.display = "block";
    renderLavaBuildingHud();
  }

  function stopLavaBuildingHud() {
    lavaBuildingHudState.enabled = false;
    if (lavaBuildingHudState.container) lavaBuildingHudState.container.style.display = "none";
  }

  const HIDE_POPUPS_MODULE_NAME = "Hide pop-ups";
  const HIDE_POPUPS_LOG_PREFIX = "[AnRRgmHidePopups]";
  const HIDE_POPUPS_TOAST_SELECTOR = ".Toastify__toast";
  const HIDE_POPUPS_TOAST_CLOSE_SELECTOR = ".Toastify__close-button";
  const HIDE_POPUPS_ENERGY_POPUP_SELECTOR = ".maxAll.flex.hc";
  const HIDE_POPUPS_ENERGY_RESOURCE_PATH = "/assets/map/inventory/resources/";
  const HIDE_POPUPS_ENERGY_RESOURCE_IMAGE_SELECTOR = `img[src*='${HIDE_POPUPS_ENERGY_RESOURCE_PATH}']`;

  const hidePopupsState = {
    enabled: false,
    observer: null,
    hiddenBuildingPopups: 0,
    hiddenEnergyPopups: 0,
  };

  function hidePopupsLog(...args) {
    console.log(HIDE_POPUPS_LOG_PREFIX, ...args);
  }

  function getHidePopupsConfig() {
    const cfg = typeof moduleCfg === "function" ? moduleCfg(HIDE_POPUPS_MODULE_NAME) : {};
    return {
      hideEnergyPopups: cfg?.hideEnergyPopups !== false,
      hideBuildingPopups: cfg?.hideBuildingPopups !== false,
    };
  }

  function isHidePopupsElement(node) {
    return node instanceof Element;
  }

  function isHidePopupsEnergyResourceImage(node) {
    if (!isHidePopupsElement(node) || node.tagName !== "IMG") return false;

    const src = node.getAttribute("src") || node.src || node.currentSrc || "";
    return src.includes(HIDE_POPUPS_ENERGY_RESOURCE_PATH);
  }

  function isHidePopupsEnergyPopup(node) {
    return isHidePopupsElement(node)
      && node.matches(HIDE_POPUPS_ENERGY_POPUP_SELECTOR)
      && Boolean(node.querySelector(HIDE_POPUPS_ENERGY_RESOURCE_IMAGE_SELECTOR));
  }

  function findHidePopupsEnergyPopup(node) {
    if (!isHidePopupsElement(node)) return null;
    if (isHidePopupsEnergyPopup(node)) return node;

    const popup = isHidePopupsEnergyResourceImage(node)
      ? node.closest(HIDE_POPUPS_ENERGY_POPUP_SELECTOR)
      : node.querySelector(HIDE_POPUPS_ENERGY_RESOURCE_IMAGE_SELECTOR)?.closest(HIDE_POPUPS_ENERGY_POPUP_SELECTOR);
    return isHidePopupsEnergyPopup(popup) ? popup : null;
  }

  function hideBuildingPopup(toast) {
    const cfg = getHidePopupsConfig();
    if (!hidePopupsState.enabled
      || !cfg.hideBuildingPopups
      || !isHidePopupsElement(toast)
      || toast.dataset.anrrgmPopupHidden === "building") return false;

    toast.dataset.anrrgmPopupHidden = "building";
    toast.style.display = "none";
    toast.querySelector(HIDE_POPUPS_TOAST_CLOSE_SELECTOR)?.click();
    hidePopupsState.hiddenBuildingPopups += 1;
    hidePopupsLog("Hid building popup", toast);
    return true;
  }

  function hideEnergyPopup(popup) {
    const cfg = getHidePopupsConfig();
    if (!hidePopupsState.enabled
      || !cfg.hideEnergyPopups
      || !isHidePopupsEnergyPopup(popup)
      || popup.dataset.anrrgmPopupHidden === "energy") return false;

    popup.dataset.anrrgmPopupHidden = "energy";
    popup.style.display = "none";
    hidePopupsState.hiddenEnergyPopups += 1;
    hidePopupsLog("Hid energy/resource popup", popup);
    return true;
  }

  function scanHidePopupNode(node) {
    if (!isHidePopupsElement(node)) return;

    if (node.matches(HIDE_POPUPS_TOAST_SELECTOR)) hideBuildingPopup(node);
    const energyPopup = findHidePopupsEnergyPopup(node);
    if (energyPopup) hideEnergyPopup(energyPopup);

    node.querySelectorAll?.(HIDE_POPUPS_TOAST_SELECTOR).forEach(hideBuildingPopup);
    node.querySelectorAll?.(HIDE_POPUPS_ENERGY_POPUP_SELECTOR).forEach((candidate) => {
      if (isHidePopupsEnergyPopup(candidate)) hideEnergyPopup(candidate);
    });
    node.querySelectorAll?.(HIDE_POPUPS_ENERGY_RESOURCE_IMAGE_SELECTOR).forEach((image) => {
      const popup = findHidePopupsEnergyPopup(image);
      if (popup) hideEnergyPopup(popup);
    });
  }

  function scanHidePopupsDocument() {
    scanHidePopupNode(document.documentElement);
  }

  function observeHidePopups() {
    if (hidePopupsState.observer || !document.documentElement) return;

    hidePopupsState.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") scanHidePopupNode(mutation.target);
        for (const node of mutation.addedNodes) scanHidePopupNode(node);
      }
    });

    hidePopupsState.observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "src"], childList: true, subtree: true });
  }

  function syncHidePopups() {
    if (hidePopupsState.enabled) scanHidePopupsDocument();
  }

  function startHidePopups() {
    hidePopupsState.enabled = true;
    observeHidePopups();
    scanHidePopupsDocument();
    hidePopupsLog("Enabled");
  }

  function stopHidePopups() {
    hidePopupsState.enabled = false;
    hidePopupsLog("Disabled");
  }

  window.__anrrgmHidePopups = {
    enable: startHidePopups,
    disable: stopHidePopups,
    rescan: scanHidePopupsDocument,
    sync: syncHidePopups,
    status() {
      return {
        enabled: hidePopupsState.enabled,
        observer: Boolean(hidePopupsState.observer),
        ...getHidePopupsConfig(),
        hiddenBuildingPopups: hidePopupsState.hiddenBuildingPopups,
        hiddenEnergyPopups: hidePopupsState.hiddenEnergyPopups,
      };
    },
  };

  const ANIMATION_SKIP_MODULE_NAME = "Animation skip (UI)";
  const LEGACY_ANIMATION_SKIP_MODULE_NAME = "Animation Skip";
  const ANIMATION_SKIP_STYLE_ID = "anrrgm-animation-skip-style";
  let originalElementAnimate = null;
  let animationSkipRouteWatcher = null;

  function isLikelyInActiveMatch() {
    return !!document.querySelector("canvas");
  }

  function shouldPauseAnimationSkipForJoinMenu() {
    const onJoinRoute = String(location?.pathname || "").startsWith("/join");
    return onJoinRoute && !isLikelyInActiveMatch();
  }

  function applyAnimationSkipState(enabled) {
    if (!enabled) {
      const styleEl = document.getElementById(ANIMATION_SKIP_STYLE_ID);
      if (styleEl) styleEl.remove();
      if (originalElementAnimate && typeof Element !== "undefined") {
        Element.prototype.animate = originalElementAnimate;
        originalElementAnimate = null;
      }
      return;
    }

    let styleEl = document.getElementById(ANIMATION_SKIP_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = ANIMATION_SKIP_STYLE_ID;
      document.documentElement.appendChild(styleEl);
    }
    styleEl.textContent = `
      *, *::before, *::after {
        transition: none !important;
        transition-duration: 0ms !important;
        transition-delay: 0ms !important;
        animation: none !important;
        animation-duration: 0ms !important;
        animation-delay: 0ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
      }
    `;

    if (!originalElementAnimate && typeof Element !== "undefined" && typeof Element.prototype?.animate === "function") {
      originalElementAnimate = Element.prototype.animate;
      Element.prototype.animate = function patchedAnimate(keyframes, options) {
        const normalized = typeof options === "number" ? { duration: options } : { ...(options || {}) };
        normalized.duration = 0;
        normalized.delay = 0;
        normalized.endDelay = 0;
        normalized.iterations = 1;
        const animation = originalElementAnimate.call(this, keyframes, normalized);
        try { animation.finish(); } catch (_) {}
        return animation;
      };
    }
  }

  function startAnimationSkip() {
    const syncMode = () => applyAnimationSkipState(!shouldPauseAnimationSkipForJoinMenu());
    syncMode();
    if (animationSkipRouteWatcher) clearInterval(animationSkipRouteWatcher);
    animationSkipRouteWatcher = setInterval(syncMode, 400);
  }

  function stopAnimationSkip() {
    if (animationSkipRouteWatcher) {
      clearInterval(animationSkipRouteWatcher);
      animationSkipRouteWatcher = null;
    }
    applyAnimationSkipState(false);
  }

  function getModuleConfigSafe(name, fallback = {}) {
    if (typeof moduleCfg !== "function") return fallback;
    try {
      return moduleCfg(name) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  const ANTI_AFK_MODULE_NAME = "Anti AFK";
  const antiAfkState = {
    intervalId: null,
    phase: 0,
  };

  function getAntiAfkConfig() {
    const cfg = getModuleConfigSafe(ANTI_AFK_MODULE_NAME);
    const pulseMs = Math.max(4000, Number(cfg.pulseMs) || 12000);
    return { pulseMs };
  }

  function dispatchAntiAfkPulse() {
    const phase = antiAfkState.phase++ % 4;
    if (phase === 0) {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 6, clientY: 6, bubbles: true }));
      return;
    }
    if (phase === 1) {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10, bubbles: true }));
      return;
    }
    if (phase === 2) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true }));
      return;
    }
    document.dispatchEvent(new Event("visibilitychange", { bubbles: false }));
  }

  function startAntiAfk() {
    if (antiAfkState.intervalId) clearInterval(antiAfkState.intervalId);
    const { pulseMs } = getAntiAfkConfig();
    dispatchAntiAfkPulse();
    antiAfkState.intervalId = setInterval(() => {
      dispatchAntiAfkPulse();
    }, pulseMs);
  }

  function stopAntiAfk() {
    if (antiAfkState.intervalId) {
      clearInterval(antiAfkState.intervalId);
      antiAfkState.intervalId = null;
    }
  }


  const LEGACY_STYLES_MODULE_NAME = "Styles";
  const STYLES_MODULE_NAME = "Theme";
  const QUESTION_STYLES_DEFAULTS = {
    topBarBackground: "#0f172a",
    pageBackground: "#020617",
    correctBackground: "#166534",
    wrongBackground: "#7f1d1d",
    continueButtonBackground: "#0f1e3a",
    shopButtonBackground: "#431407",
    questionBackground: "#101827",
    questionText: "#e0f2fe",
    option1Background: "#771322",
    option1Text: "#ffffff",
    option2Background: "#a85c15",
    option2Text: "#ffffff",
    option3Background: "#0d6b33",
    option3Text: "#ffffff",
    option4Background: "#076296",
    option4Text: "#ffffff",
    questionFontSize: 30,
    answerFontSize: 22,
    borderRadius: 18,
    useGlobalTheme: false,
    stylePreset: "midnight",
  };
  const QUESTION_STYLES_PRESETS = {
    default: {
      label: "Default Gimkit",
      values: {
        topBarBackground: "#4252af",
        pageBackground: "#f5f7fb",
        correctBackground: "#0d6b33",
        wrongBackground: "#771322",
        continueButtonBackground: "#076296",
        shopButtonBackground: "#076296",
        questionBackground: "#303f9f",
        questionText: "#ffffff",
        option1Background: "#771322",
        option1Text: "#ffffff",
        option2Background: "#a85c15",
        option2Text: "#ffffff",
        option3Background: "#0d6b33",
        option3Text: "#ffffff",
        option4Background: "#076296",
        option4Text: "#ffffff",
        questionFontSize: 28,
        answerFontSize: 20,
        borderRadius: 0,
        useGlobalTheme: false,
      },
    },
    midnight: {
      label: "Midnight",
      values: {
        topBarBackground: "#0f172a",
        pageBackground: "#020617",
        correctBackground: "#166534",
        wrongBackground: "#7f1d1d",
        continueButtonBackground: "#0f1e3a",
        shopButtonBackground: "#431407",
        questionBackground: "#101827",
        questionText: "#e0f2fe",
        option1Background: "#771322",
        option1Text: "#ffffff",
        option2Background: "#a85c15",
        option2Text: "#ffffff",
        option3Background: "#0d6b33",
        option3Text: "#ffffff",
        option4Background: "#076296",
        option4Text: "#ffffff",
        questionFontSize: 30,
        answerFontSize: 22,
        borderRadius: 18,
      },
    },
    dark: {
      label: "Dark",
      values: {
        topBarBackground: "#030712",
        pageBackground: "#00030a",
        correctBackground: "#052e16",
        wrongBackground: "#1f2937",
        continueButtonBackground: "#0f1f3d",
        shopButtonBackground: "#111827",
        questionBackground: "#050816",
        questionText: "#e5e7eb",
        option1Background: "#111827",
        option1Text: "#f3f4f6",
        option2Background: "#0b1120",
        option2Text: "#e5e7eb",
        option3Background: "#101820",
        option3Text: "#d1d5db",
        option4Background: "#111a2e",
        option4Text: "#dbeafe",
        questionFontSize: 30,
        answerFontSize: 22,
        borderRadius: 12,
      },
    },
    highContrast: {
      label: "High Contrast",
      values: {
        topBarBackground: "#000000",
        pageBackground: "#ffffff",
        correctBackground: "#008000",
        wrongBackground: "#ff0000",
        continueButtonBackground: "#0000ff",
        shopButtonBackground: "#ffcc00",
        questionBackground: "#ffffff",
        questionText: "#000000",
        option1Background: "#ff0000",
        option1Text: "#ffffff",
        option2Background: "#ffcc00",
        option2Text: "#000000",
        option3Background: "#008000",
        option3Text: "#ffffff",
        option4Background: "#0000ff",
        option4Text: "#ffffff",
        questionFontSize: 32,
        answerFontSize: 24,
        borderRadius: 8,
      },
    },
    pastel: {
      label: "Pastel",
      values: {
        topBarBackground: "#6d5bd0",
        pageBackground: "#fff7ed",
        correctBackground: "#bbf7d0",
        wrongBackground: "#fecaca",
        continueButtonBackground: "#93c5fd",
        shopButtonBackground: "#fde68a",
        questionBackground: "#f8fafc",
        questionText: "#1f2937",
        option1Background: "#fecaca",
        option1Text: "#451a1a",
        option2Background: "#fde68a",
        option2Text: "#3f2a00",
        option3Background: "#bbf7d0",
        option3Text: "#12351f",
        option4Background: "#93c5fd",
        option4Text: "#10233f",
        questionFontSize: 28,
        answerFontSize: 21,
        borderRadius: 22,
      },
    },
    forest: {
      label: "Forest",
      values: {
        topBarBackground: "#1f3d2b",
        pageBackground: "#102015",
        correctBackground: "#2f6b3f",
        wrongBackground: "#3f2f1f",
        continueButtonBackground: "#27452f",
        shopButtonBackground: "#24381e",
        questionBackground: "#263a24",
        questionText: "#f4f7e8",
        option1Background: "#25422a",
        option1Text: "#edf7df",
        option2Background: "#24381e",
        option2Text: "#f4f7e8",
        option3Background: "#1f5a32",
        option3Text: "#ecfdf5",
        option4Background: "#224235",
        option4Text: "#e0f2f1",
        questionFontSize: 30,
        answerFontSize: 22,
        borderRadius: 12,
      },
    },
  };
  const QUESTION_STYLE_SCREEN_SELECTOR = '[style*="opacity:"][style*="translateY(0%)"]';
  const QUESTION_STYLE_SHELL_SELECTOR = ".gAlRHP, .dujAvP, .cZgLFG, .cChptk, .ljtfrY, .dDfMyc, .dBwWbX";
  const QUESTION_STYLE_INTERACTIVE_SELECTOR = [
    "button",
    '[role="button"]',
    "[tabindex]",
    '[class*="answer" i]',
    '[class*="option" i]',
    '[style*="cursor: pointer" i]',
  ].join(",");
  const QUESTION_STYLE_CONTINUE_TEXT_PATTERN = /(?:^|\b)(continue|next|ok|okay)(?:\b|$)/i;
  const QUESTION_STYLE_SHOP_TEXT_PATTERN = /(?:^|\b)(shop|open shop|store)(?:\b|$)/i;
  const QUESTION_STYLE_ACTION_TEXT_MAX_LENGTH = 90;
  const questionStylesState = {
    observer: null,
    changedElements: new Set(),
    originalStyles: new WeakMap(),
    syncQueued: false,
    syncFrameId: null,
    burstFrameId: null,
    burstFramesRemaining: 0,
    currentRoot: null,
  };

  function getStylesConfigStore() {
    if (!(state.moduleConfig instanceof Map)) return null;
    let cfg = state.moduleConfig.get(STYLES_MODULE_NAME);
    if ((!cfg || typeof cfg !== "object") && state.moduleConfig.has(LEGACY_STYLES_MODULE_NAME)) {
      cfg = state.moduleConfig.get(LEGACY_STYLES_MODULE_NAME);
      if (cfg && typeof cfg === "object") {
        state.moduleConfig.set(STYLES_MODULE_NAME, cfg);
        state.moduleConfig.delete(LEGACY_STYLES_MODULE_NAME);
      }
    }
    if (!cfg || typeof cfg !== "object") {
      cfg = { keybind: null, ...QUESTION_STYLES_DEFAULTS };
      state.moduleConfig.set(STYLES_MODULE_NAME, cfg);
    }
    for (const [key, value] of Object.entries(QUESTION_STYLES_DEFAULTS)) {
      if (cfg[key] === undefined) cfg[key] = value;
    }
    return cfg;
  }

  function getStylesConfig() {
    const cfg = getStylesConfigStore() || {};
    return { ...QUESTION_STYLES_DEFAULTS, ...cfg };
  }

  function applyStylesPresetToConfig(cfg, presetName) {
    if (!cfg || typeof cfg !== "object") return;
    const preset = QUESTION_STYLES_PRESETS[presetName];
    if (!preset) return;
    Object.assign(cfg, preset.values, { stylePreset: presetName });
  }

  function isStylesHexColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }
  function getComputedBackgroundValue(element, fallback) {
    if (!(element instanceof HTMLElement)) return fallback;
    const computed = window.getComputedStyle(element);
    return computed.backgroundImage && computed.backgroundImage !== "none" ? computed.backgroundImage : computed.backgroundColor || fallback;
  }

  function parseCssRgb(value) {
    const match = String(value || "").match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!match) return null;
    return {
      r: Math.max(0, Math.min(255, Number(match[1]) || 0)),
      g: Math.max(0, Math.min(255, Number(match[2]) || 0)),
      b: Math.max(0, Math.min(255, Number(match[3]) || 0)),
      a: match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4]) || 0)),
    };
  }

  function opaqueCssColorOverBlack(value, fallback = "#000000") {
    const parsed = parseCssRgb(value);
    if (!parsed) return value && value !== "transparent" ? value : fallback;
    const r = Math.round(parsed.r * parsed.a);
    const g = Math.round(parsed.g * parsed.a);
    const b = Math.round(parsed.b * parsed.a);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function getComputedOpaqueBackgroundColor(element, fallback = "#000000") {
    if (!(element instanceof HTMLElement)) return fallback;
    return opaqueCssColorOverBlack(window.getComputedStyle(element).backgroundColor, fallback);
  }

  function darkenCssBackground(value, factor = 0.72) {
    const darkenPart = (r, g, b, alpha = null) => {
      const nr = Math.max(0, Math.min(255, Math.round(Number(r) * factor)));
      const ng = Math.max(0, Math.min(255, Math.round(Number(g) * factor)));
      const nb = Math.max(0, Math.min(255, Math.round(Number(b) * factor)));
      return alpha == null ? `rgb(${nr}, ${ng}, ${nb})` : `rgba(${nr}, ${ng}, ${nb}, ${alpha})`;
    };
    return String(value || "").replace(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/gi, (_match, r, g, b, a) => darkenPart(r, g, b, a ?? null));
  }

  function cssBackgroundLayer(value) {
    const background = String(value || "").trim();
    if (!background || background === "transparent") return "";
    if (/gradient\(|url\(/i.test(background)) return background;
    return `linear-gradient(${background}, ${background})`;
  }

  function composeGlobalThemeLayeredBackground(overlayBackground, baseBackground = "#000000") {
    const baseLayer = cssBackgroundLayer(baseBackground) || baseBackground;
    const overlayLayer = cssBackgroundLayer(overlayBackground);
    return overlayLayer ? `${overlayLayer}, ${baseLayer}` : baseLayer;
  }

  function composeGlobalThemeButtonBackground(globalTheme) {
    if (!globalTheme) return "";
    return composeGlobalThemeLayeredBackground(globalTheme.activeBackground, globalTheme.inactiveBackground || "#000000");
  }

  function getStylesGlobalThemeValues() {
    const uiRoot = document.querySelector(".anrrgm-root");
    const activeModule = uiRoot?.querySelector?.(".anrrgm-module.active")
      || state.moduleItems?.get?.(STYLES_MODULE_NAME)
      || uiRoot?.querySelector?.(".anrrgm-module");
    const inactiveModule = uiRoot?.querySelector?.(".anrrgm-module:not(.active)")
      || uiRoot?.querySelector?.(".anrrgm-module");
    const categoryHeader = uiRoot?.querySelector?.(".anrrgm-panel-header");
    const activeFallback = "linear-gradient(90deg, rgba(255, 61, 61, 0.35), rgba(60, 18, 18, 0.82))";
    const inactiveFallback = "#000000";
    const categoryFallback = "linear-gradient(90deg, rgba(255, 74, 74, 0.24), rgba(60, 18, 18, 0.92))";
    const uiComputed = uiRoot instanceof HTMLElement ? window.getComputedStyle(uiRoot) : null;
    const radiusFallback = uiComputed?.getPropertyValue("--arr-radius-md")?.trim() || `${QUESTION_STYLES_DEFAULTS.borderRadius}px`;
    const activeComputed = activeModule instanceof HTMLElement ? window.getComputedStyle(activeModule) : null;
    const categoryBackground = getComputedBackgroundValue(categoryHeader, categoryFallback);
    const activeBackground = getComputedBackgroundValue(activeModule, activeFallback);
    const inactiveBackground = getComputedOpaqueBackgroundColor(inactiveModule, inactiveFallback);
    return {
      activeBackground,
      inactiveBackground,
      buttonBackground: composeGlobalThemeButtonBackground({ activeBackground, inactiveBackground }),
      categoryBackground: composeGlobalThemeLayeredBackground(activeBackground || darkenCssBackground(categoryBackground, 0.62), "#000000"),
      borderRadius: activeComputed?.borderRadius || radiusFallback,
    };
  }

  function resolveStylesBackground(value, fallback) {
    return isStylesHexColor(value, fallback);
  }

  function clampStylesNumber(value, min, max, fallback) {
    const parsed = Number(value);
    const fallbackNumber = Number(fallback);
    const nextValue = Number.isFinite(parsed) ? parsed : fallbackNumber;
    return Math.max(min, Math.min(max, Number.isFinite(nextValue) ? nextValue : min));
  }


  function getAnRRgmOwnUiSelector() {
    return [
      ".anrrgm-root",
      ".anrrgm-config-backdrop",
      ".anrrgm-config",
      ".anrrgm-settings",
      ".anrrgm-answer-popup",
      ".anrrgm-upgrade-hud",
      ".anrrgm-ability-hud",
      "#anrrgm-menu-shell",
      "#anrrgm-config-menu",
      "#anrrgm-settings-menu",
      "#anrrgm-config-backdrop",
      "#anrrgm-welcome-card",
      "#anrrgm-target-menu",
    ].join(",");
  }

  function isQuestionStyleElement(value) {
    return value instanceof HTMLElement && !value.closest(getAnRRgmOwnUiSelector());
  }

  function isQuestionStyleVisible(element) {
    if (!isQuestionStyleElement(element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 20 && rect.height >= 20 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function rememberQuestionStyle(element, property) {
    if (!isQuestionStyleElement(element)) return;
    let original = questionStylesState.originalStyles.get(element);
    if (!original) {
      original = {};
      questionStylesState.originalStyles.set(element, original);
      questionStylesState.changedElements.add(element);
    }
    if (!Object.prototype.hasOwnProperty.call(original, property)) {
      original[property] = {
        value: element.style.getPropertyValue(property) || "",
        priority: element.style.getPropertyPriority(property) || "",
      };
    }
  }

  function setQuestionInlineStyle(element, property, value) {
    if (!isQuestionStyleElement(element)) return;
    const nextValue = String(value ?? "");
    rememberQuestionStyle(element, property);
    if (property === "background") rememberQuestionStyle(element, "background-color");
    if (element.style.getPropertyValue(property) === nextValue && element.style.getPropertyPriority(property) === "important") return;
    element.style.setProperty(property, nextValue, "important");
  }

  function restoreQuestionStyleElement(element) {
    const original = questionStylesState.originalStyles.get(element);
    if (!original || !(element instanceof HTMLElement)) return false;
    for (const [property, snapshot] of Object.entries(original)) {
      if (snapshot?.value) element.style.setProperty(property, snapshot.value, snapshot.priority || "");
      else element.style.removeProperty(property);
    }
    questionStylesState.changedElements.delete(element);
    return true;
  }

  function restoreQuestionStyles() {
    for (const element of questionStylesState.changedElements) restoreQuestionStyleElement(element);
    questionStylesState.changedElements.clear();
    questionStylesState.originalStyles = new WeakMap();
  }

  function restoreExcludedQuestionNavigationStyles() {
    for (const element of [...questionStylesState.changedElements]) {
      if (isQuestionExcludedNavigationAction(element)) restoreQuestionStyleElement(element);
    }
  }

  function getQuestionStyleInteractiveText(element) {
    return String(element?.textContent || element?.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim();
  }

  function isQuestionExcludedNavigationAction(element) {
    return element instanceof HTMLElement
      && Boolean(element.closest(".MuiListItem-root, .MuiDrawer-root, .MuiList-root"));
  }

  function isQuestionStyleClickableElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    const tagName = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    const className = String(element.className || "");
    const style = window.getComputedStyle(element);
    return tagName === "button"
      || tagName === "a"
      || role === "button"
      || role === "link"
      || style.cursor === "pointer"
      || element.tabIndex >= 0
      || /(?:^|[-_\s])(btn|button)(?:[-_\s]|$)/i.test(className);
  }

  function isQuestionActionTextMatch(element, textPattern) {
    const text = getQuestionStyleInteractiveText(element);
    return Boolean(text && text.length <= QUESTION_STYLE_ACTION_TEXT_MAX_LENGTH && textPattern.test(text));
  }

  function findQuestionActionSurface(element) {
    if (!isQuestionStyleVisible(element) || isQuestionExcludedNavigationAction(element)) return null;
    let current = element;
    for (let depth = 0; current instanceof HTMLElement && depth < 5; depth += 1, current = current.parentElement) {
      if (!isQuestionStyleElement(current) || current === document.body || current === document.documentElement) break;
      if (isQuestionStyleClickableElement(current) && isQuestionStyleVisible(current)) return current;
    }
    const rect = element.getBoundingClientRect();
    if (elementHasVisibleBackground(element) && rect.width <= 340 && rect.height <= 120) return element;
    return null;
  }

  function isLikelyQuestionActionButton(element, textPattern) {
    return isQuestionActionTextMatch(element, textPattern) && Boolean(findQuestionActionSurface(element));
  }

  function addQuestionActionCandidate(buttons, seen, element, textPattern, limit) {
    if (!(element instanceof HTMLElement) || isQuestionExcludedNavigationAction(element) || !isQuestionActionTextMatch(element, textPattern)) return false;
    const surface = findQuestionActionSurface(element);
    if (!(surface instanceof HTMLElement) || seen.has(surface)) return false;
    seen.add(surface);
    buttons.push(surface);
    return buttons.length >= limit;
  }

  function getQuestionActionButtonCandidates(textPattern, root = document, limit = 6) {
    const searchRoot = root && typeof root.querySelectorAll === "function" ? root : document;
    const buttons = [];
    const seen = new Set();
    for (const element of searchRoot.querySelectorAll(QUESTION_STYLE_INTERACTIVE_SELECTOR)) {
      if (addQuestionActionCandidate(buttons, seen, element, textPattern, limit)) return buttons;
    }
    const walkerRoot = searchRoot === document ? document.body : searchRoot;
    if (walkerRoot instanceof HTMLElement) {
      const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          if (!(node instanceof HTMLElement) || !isQuestionStyleElement(node)) return NodeFilter.FILTER_REJECT;
          if (isQuestionExcludedNavigationAction(node)) return NodeFilter.FILTER_REJECT;
          if (!node.children.length && isQuestionActionTextMatch(node, textPattern)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        },
      });
      let scanned = 0;
      for (let node = walker.nextNode(); node && scanned < 3000; node = walker.nextNode(), scanned += 1) {
        if (addQuestionActionCandidate(buttons, seen, node, textPattern, limit)) break;
      }
    }
    return buttons;
  }

  function getQuestionContinueButtonCandidates(root = document) {
    return getQuestionActionButtonCandidates(QUESTION_STYLE_CONTINUE_TEXT_PATTERN, root);
  }

  function getQuestionShopButtonCandidates(root = document) {
    return getQuestionActionButtonCandidates(QUESTION_STYLE_SHOP_TEXT_PATTERN, root);
  }

  function getQuestionOptionCandidates(root) {
    if (!isQuestionStyleElement(root)) return [];
    const seen = new Set();
    const options = [];
    for (const element of root.querySelectorAll(QUESTION_STYLE_INTERACTIVE_SELECTOR)) {
      if (!isQuestionStyleVisible(element) || seen.has(element)) continue;
      const rect = element.getBoundingClientRect();
      const text = String(element.textContent || "").trim();
      if (!text || rect.width < 70 || rect.height < 30) continue;
      if (element.closest(getAnRRgmOwnUiSelector())) continue;
      seen.add(element);
      options.push(element);
    }
    return options
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top === br.top ? ar.left - br.left : ar.top - br.top;
      })
      .slice(0, 4);
  }

  function scoreQuestionStyleRoot(element) {
    if (!isQuestionStyleVisible(element)) return -1;
    const text = String(element.textContent || "").trim();
    if (text.length < 4) return -1;
    const interactiveTotal = element.querySelectorAll?.(QUESTION_STYLE_INTERACTIVE_SELECTOR).length || 0;
    if (interactiveTotal > 8 && !/question|answer|option|prompt/i.test(element.className || "")) return -1;
    const options = getQuestionOptionCandidates(element);
    if (options.length < 2) return -1;
    const rect = element.getBoundingClientRect();
    let score = options.length * 30;
    if (options.length === 4) score += 45;
    if (/question|answer|option|prompt/i.test(element.className || "")) score += 20;
    const inlineStyle = element.getAttribute("style") || "";
    if (/opacity\s*:/.test(inlineStyle) && /translateY\(0%\)/.test(inlineStyle)) score += 35;
    if (rect.width > 250 && rect.height > 180) score += 15;
    return score;
  }

  function collectQuestionStyleCandidates() {
    const selectors = [
      QUESTION_STYLE_SCREEN_SELECTOR,
      '[style*="translateY(0%)"]',
      '[class*="question" i]',
      '[class*="answer" i]',
      "main",
      "section",
    ].join(",");
    const candidates = new Set();
    for (const element of document.querySelectorAll(selectors)) {
      if (isQuestionStyleElement(element)) candidates.add(element);
    }

    let interactiveCount = 0;
    for (const element of document.querySelectorAll(QUESTION_STYLE_INTERACTIVE_SELECTOR)) {
      if (!isQuestionStyleElement(element)) continue;
      const text = String(element.textContent || "").trim();
      if (!text) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 70 || rect.height < 30) continue;
      interactiveCount += 1;
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
        if (parent.matches?.("main,section") || parent.querySelectorAll?.(QUESTION_STYLE_INTERACTIVE_SELECTOR).length >= 2) {
          if (isQuestionStyleElement(parent)) candidates.add(parent);
        }
      }
      if (interactiveCount >= 8) break;
    }
    return candidates;
  }

  function findQuestionStyleRoot() {
    const candidates = collectQuestionStyleCandidates();
    let best = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = scoreQuestionStyleRoot(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return bestScore >= 0 ? best : null;
  }

  function hasQuestionStyleShell() {
    return Boolean(document.querySelector(QUESTION_STYLE_SHELL_SELECTOR));
  }

  function hasLikelyQuestionStyleSurface(hasShell = hasQuestionStyleShell()) {
    if (hasShell) return true;
    if (isQuestionStyleVisible(questionStylesState.currentRoot)) return true;
    const direct = document.querySelector(QUESTION_STYLE_SCREEN_SELECTOR);
    if (isQuestionStyleVisible(direct)) return true;
    if (getQuestionContinueButtonCandidates().length > 0) return true;
    if (getQuestionShopButtonCandidates().length > 0) return true;
    if (getQuestionTopBarCandidates(1).length > 0) return true;
    return false;
  }

  function findQuestionDisplay(root, options) {
    if (!isQuestionStyleElement(root)) return null;
    const optionSet = new Set(options || []);
    const optionTop = options?.length ? Math.min(...options.map((option) => option.getBoundingClientRect().top)) : Infinity;
    const selectors = ["h1", "h2", "h3", '[class*="question" i]', '[class*="prompt" i]', '[data-testid*="question" i]', "p", "div"].join(",");
    let best = null;
    let bestScore = -1;
    for (const element of root.querySelectorAll(selectors)) {
      if (!isQuestionStyleVisible(element) || optionSet.has(element)) continue;
      if ([...optionSet].some((option) => element.contains(option) || option.contains(element))) continue;
      const text = String(element.textContent || "").trim();
      if (text.length < 4 || text.length > 600) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top > optionTop + 8) continue;
      let score = Math.min(text.length, 120);
      if (/question|prompt/i.test(element.className || "")) score += 35;
      if (/^H[1-3]$/.test(element.tagName)) score += 25;
      score += Math.min(rect.width, 900) / 25;
      if (rect.bottom <= optionTop + 12) score += 30;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best || root;
  }


  function getElementChild(element, index) {
    if (!isQuestionStyleElement(element)) return null;
    const child = element.children?.[index];
    return child instanceof HTMLElement ? child : null;
  }

  function findReferenceQuestionTargets() {
    let root = questionStylesState.currentRoot;
    if (!isQuestionStyleVisible(root)) root = null;
    if (!root) {
      const direct = document.querySelector(QUESTION_STYLE_SCREEN_SELECTOR);
      root = isQuestionStyleVisible(direct) ? direct : null;
    }
    if (!root) return null;

    const questionDisplay = getElementChild(getElementChild(getElementChild(getElementChild(root, 0), 0), 0), 0);
    const optionsWrap = getElementChild(root, 1);
    const options = [];
    if (optionsWrap) {
      for (const option of Array.from(optionsWrap.children || [])) {
        if (!(option instanceof HTMLElement)) continue;
        const optionDisplay = getElementChild(option, 0) || option;
        if (isQuestionStyleVisible(optionDisplay)) options.push(optionDisplay);
        if (options.length >= 4) break;
      }
    }
    if (questionDisplay && options.length >= 2) {
      questionStylesState.currentRoot = root;
      return { root, question: questionDisplay, options };
    }
    return null;
  }

  function captureQuestionStyleRootFromNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches?.(QUESTION_STYLE_SCREEN_SELECTOR)) {
      questionStylesState.currentRoot = node;
      return;
    }
    const found = node.querySelector?.(QUESTION_STYLE_SCREEN_SELECTOR);
    if (found instanceof HTMLElement) questionStylesState.currentRoot = found;
  }

  function findQuestionStyleTargets() {
    const referenceTargets = findReferenceQuestionTargets();
    if (referenceTargets) return referenceTargets;
    const direct = document.querySelector(QUESTION_STYLE_SCREEN_SELECTOR);
    const root = isQuestionStyleVisible(direct) ? direct : null;
    if (!root) return null;
    const options = getQuestionOptionCandidates(root);
    if (options.length < 2) return null;
    const question = findQuestionDisplay(root, options);
    return { root, question, options };
  }

  function applyQuestionTextInlineStyles(element, color, fontSizePx) {
    if (!isQuestionStyleElement(element)) return;
    setQuestionInlineStyle(element, "color", color);
    setQuestionInlineStyle(element, "font-size", `${fontSizePx}px`);
    const descendants = Array.from(element.querySelectorAll("*")).filter((child) => child instanceof HTMLElement && String(child.textContent || "").trim());
    for (const child of descendants.slice(0, 24)) {
      setQuestionInlineStyle(child, "color", color);
      setQuestionInlineStyle(child, "font-size", `${fontSizePx}px`);
    }
  }

  function elementHasVisibleBackground(element) {
    if (!(element instanceof HTMLElement)) return false;
    const computed = window.getComputedStyle(element);
    if (computed.backgroundImage && computed.backgroundImage !== "none") return true;
    const parsed = parseCssRgb(computed.backgroundColor);
    return Boolean(parsed && parsed.a > 0.01);
  }

  function isLikelyQuestionTopBar(element) {
    if (!isQuestionStyleVisible(element) || !elementHasVisibleBackground(element)) return false;
    const tagName = String(element.tagName || "").toLowerCase();
    if (["button", "a", "canvas", "svg", "img", "input", "select", "textarea"].includes(tagName)) return false;
    const rect = element.getBoundingClientRect();
    const viewportWidth = Math.max(320, window.innerWidth || 0);
    if (rect.top > 120 || rect.bottom < 12) return false;
    if (rect.width < Math.min(280, viewportWidth * 0.45)) return false;
    if (rect.height < 28 || rect.height > 120) return false;
    const text = getQuestionStyleInteractiveText(element);
    if (QUESTION_STYLE_CONTINUE_TEXT_PATTERN.test(text) || QUESTION_STYLE_SHOP_TEXT_PATTERN.test(text)) return false;
    return true;
  }

  function getQuestionTopBarCandidates(limit = 4) {
    const candidates = new Map();
    const addCandidate = (element, score = 0) => {
      if (!(element instanceof HTMLElement) || candidates.has(element) || !isLikelyQuestionTopBar(element)) return;
      const rect = element.getBoundingClientRect();
      const widthRatio = rect.width / Math.max(1, window.innerWidth || rect.width);
      candidates.set(element, score + (1 - Math.min(1, Math.max(0, rect.top) / 120)) * 40 + widthRatio * 35 - Math.abs(rect.height - 56) / 4);
    };

    for (const element of document.querySelectorAll(".gAlRHP, .dujAvP, header, nav, [class*='top' i], [class*='bar' i], [class*='header' i]")) {
      addCandidate(element, 35);
    }

    let scanned = 0;
    for (const element of document.body?.querySelectorAll?.("*") || []) {
      if (scanned >= 2500) break;
      scanned += 1;
      addCandidate(element, 0);
    }

    return [...candidates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([element]) => element);
  }

  function applyQuestionTopBarSurface(element, background) {
    if (!isQuestionStyleElement(element)) return;
    setQuestionInlineStyle(element, "background", background);
    setQuestionInlineStyle(element, "background-color", background);
    const descendants = Array.from(element.querySelectorAll("div,header,nav,section"))
      .filter((child) => child instanceof HTMLElement && elementHasVisibleBackground(child));
    for (const child of descendants.slice(0, 8)) {
      setQuestionInlineStyle(child, "background", background);
      setQuestionInlineStyle(child, "background-color", background);
    }
  }

  function isQuestionButtonPaintSurface(element) {
    if (!(element instanceof HTMLElement) || !isQuestionStyleVisible(element) || isQuestionExcludedNavigationAction(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width > 520 || rect.height > 180) return false;
    return isQuestionStyleClickableElement(element) || elementHasVisibleBackground(element);
  }

  function getQuestionButtonPaintTargets(element) {
    const targets = new Set();
    if (!isQuestionStyleElement(element) || isQuestionExcludedNavigationAction(element)) return targets;
    if (element instanceof HTMLElement) targets.add(element);

    const actionSurface = findQuestionActionSurface(element);
    if (actionSurface instanceof HTMLElement) targets.add(actionSurface);

    let current = element.parentElement;
    for (let depth = 0; current instanceof HTMLElement && depth < 5; depth += 1, current = current.parentElement) {
      if (!isQuestionStyleElement(current) || current === document.body || current === document.documentElement) break;
      if (isQuestionButtonPaintSurface(current)) targets.add(current);
    }
    return targets;
  }

  function paintQuestionButtonTarget(element, background, borderRadiusValue, baseBackground) {
    setQuestionInlineStyle(element, "background", background);
    setQuestionInlineStyle(element, "background-color", baseBackground);
    if (borderRadiusValue) setQuestionInlineStyle(element, "border-radius", borderRadiusValue);
  }

  function applyQuestionButtonSurface(element, background, borderRadiusValue, baseBackground = background) {
    if (!isQuestionStyleElement(element)) return;
    const targets = getQuestionButtonPaintTargets(element);
    if (!targets.size && element instanceof HTMLElement) targets.add(element);
    for (const target of targets) {
      paintQuestionButtonTarget(target, background, borderRadiusValue, baseBackground);
      const descendants = Array.from(target.querySelectorAll("button,[role='button'],a,div,span"))
        .filter((child) => child instanceof HTMLElement && elementHasVisibleBackground(child));
      for (const child of descendants.slice(0, 12)) {
        paintQuestionButtonTarget(child, background, borderRadiusValue, baseBackground);
      }
    }
  }

  function applyGlobalThemeButtonSurface(element, background, borderRadiusValue, baseBackground = "#000000") {
    applyQuestionButtonSurface(element, background, borderRadiusValue, baseBackground);
  }

  function getQuestionStyleScopeRoots(targets = null) {
    const roots = new Set();
    const addRoot = (element) => {
      if (!isQuestionStyleElement(element)) return;
      roots.add(element);
      const shell = element.closest?.(QUESTION_STYLE_SCREEN_SELECTOR);
      if (isQuestionStyleElement(shell)) roots.add(shell);
      const section = element.closest?.("main,section");
      if (isQuestionStyleElement(section)) roots.add(section);
    };
    addRoot(targets?.root);
    addRoot(questionStylesState.currentRoot);
    const direct = document.querySelector(QUESTION_STYLE_SCREEN_SELECTOR);
    addRoot(direct);
    for (const shellElement of document.querySelectorAll(QUESTION_STYLE_SHELL_SELECTOR)) addRoot(shellElement);
    return roots;
  }

  function queryQuestionStyleScope(scopeRoots, selector) {
    const elements = new Set();
    for (const root of scopeRoots) {
      if (!(root instanceof HTMLElement)) continue;
      if (root.matches?.(selector)) elements.add(root);
      for (const element of root.querySelectorAll(selector)) elements.add(element);
    }
    return elements;
  }

  function applyQuestionShellStyles(cfg, globalTheme = null, targets = null) {
    const topBarBackground = globalTheme?.categoryBackground || resolveStylesBackground(cfg.topBarBackground, QUESTION_STYLES_DEFAULTS.topBarBackground);
    const pageBackground = globalTheme?.inactiveBackground || resolveStylesBackground(cfg.pageBackground, QUESTION_STYLES_DEFAULTS.pageBackground);
    const continueBackground = globalTheme?.buttonBackground || resolveStylesBackground(cfg.continueButtonBackground, QUESTION_STYLES_DEFAULTS.continueButtonBackground);
    const shopBackground = globalTheme?.buttonBackground || resolveStylesBackground(cfg.shopButtonBackground, QUESTION_STYLES_DEFAULTS.shopButtonBackground);
    const borderRadiusValue = globalTheme?.borderRadius || `${clampStylesNumber(cfg.borderRadius, 0, 36, QUESTION_STYLES_DEFAULTS.borderRadius)}px`;
    const scopeRoots = getQuestionStyleScopeRoots(targets);

    const topBars = new Set([
      ...queryQuestionStyleScope(scopeRoots, ".gAlRHP, .dujAvP"),
      ...getQuestionTopBarCandidates(),
    ]);
    for (const element of topBars) {
      if (element instanceof HTMLElement) applyQuestionTopBarSurface(element, topBarBackground);
    }
    for (const element of queryQuestionStyleScope(scopeRoots, ".cZgLFG, .cChptk")) {
      if (element instanceof HTMLElement) setQuestionInlineStyle(element, "background", pageBackground);
    }
    const continueButtons = new Set([
      ...queryQuestionStyleScope(scopeRoots, ".ljtfrY, .dDfMyc"),
      ...getQuestionContinueButtonCandidates(),
    ]);
    for (const element of continueButtons) {
      if (!(element instanceof HTMLElement)) continue;
      applyQuestionButtonSurface(element, continueBackground, borderRadiusValue, globalTheme ? pageBackground : continueBackground);
    }
    const shopButtons = new Set([
      ...queryQuestionStyleScope(scopeRoots, ".dBwWbX"),
      ...getQuestionShopButtonCandidates(),
    ]);
    for (const element of shopButtons) {
      if (!(element instanceof HTMLElement)) continue;
      applyQuestionButtonSurface(element, shopBackground, borderRadiusValue, globalTheme ? pageBackground : shopBackground);
    }
  }

  function applyQuestionStyles() {
    const hasShell = hasQuestionStyleShell();
    if (!hasLikelyQuestionStyleSurface(hasShell)) return false;

    const targets = findQuestionStyleTargets();
    const hasContinueButton = getQuestionContinueButtonCandidates().length > 0;
    const hasShopButton = getQuestionShopButtonCandidates().length > 0;
    const hasTopBar = getQuestionTopBarCandidates(1).length > 0;
    if (!targets && !hasShell && !hasContinueButton && !hasShopButton && !hasTopBar) return false;

    restoreExcludedQuestionNavigationStyles();

    const cfg = getStylesConfig();
    const globalTheme = cfg.useGlobalTheme ? getStylesGlobalThemeValues() : null;
    applyQuestionShellStyles(cfg, globalTheme, targets);
    if (!targets) return true;
    const questionFontSize = clampStylesNumber(cfg.questionFontSize, 12, 64, QUESTION_STYLES_DEFAULTS.questionFontSize);
    const answerFontSize = clampStylesNumber(cfg.answerFontSize, 10, 48, QUESTION_STYLES_DEFAULTS.answerFontSize);
    const borderRadius = clampStylesNumber(cfg.borderRadius, 0, 36, QUESTION_STYLES_DEFAULTS.borderRadius);
    const borderRadiusValue = globalTheme?.borderRadius || `${borderRadius}px`;
    const questionBackground = globalTheme?.inactiveBackground || resolveStylesBackground(cfg.questionBackground, QUESTION_STYLES_DEFAULTS.questionBackground);

    if (targets.question) {
      setQuestionInlineStyle(targets.question, "background", questionBackground);
      setQuestionInlineStyle(targets.question, "border-radius", borderRadiusValue);
      applyQuestionTextInlineStyles(targets.question, isStylesHexColor(cfg.questionText, QUESTION_STYLES_DEFAULTS.questionText), questionFontSize);
    }

    targets.options.forEach((option, index) => {
      const optionNumber = index + 1;
      const optionBackground = globalTheme?.buttonBackground || resolveStylesBackground(cfg[`option${optionNumber}Background`], QUESTION_STYLES_DEFAULTS[`option${optionNumber}Background`]);
      if (globalTheme) applyGlobalThemeButtonSurface(option, optionBackground, borderRadiusValue, globalTheme.inactiveBackground);
      else setQuestionInlineStyle(option, "background", optionBackground);
      applyQuestionTextInlineStyles(option, isStylesHexColor(cfg[`option${optionNumber}Text`], QUESTION_STYLES_DEFAULTS[`option${optionNumber}Text`]), answerFontSize);
      setQuestionInlineStyle(option, "border-radius", borderRadiusValue);
    });
    return true;
  }

  function isQuestionStylesEnabled() {
    return Boolean(state.enabledModules.has(STYLES_MODULE_NAME) || state.modules.get(STYLES_MODULE_NAME)?.enabled);
  }

  function runQuestionStylesBurst(frameCount = 6) {
    if (!isQuestionStylesEnabled()) return;
    questionStylesState.burstFramesRemaining = Math.max(questionStylesState.burstFramesRemaining || 0, frameCount);
    if (questionStylesState.burstFrameId) return;
    const tick = () => {
      questionStylesState.burstFrameId = null;
      if (!isQuestionStylesEnabled()) {
        questionStylesState.burstFramesRemaining = 0;
        return;
      }
      if (!applyQuestionStyles()) {
        questionStylesState.burstFramesRemaining = 0;
        return;
      }
      questionStylesState.burstFramesRemaining -= 1;
      if (questionStylesState.burstFramesRemaining > 0) {
        questionStylesState.burstFrameId = requestAnimationFrame(tick);
      }
    };
    questionStylesState.burstFrameId = requestAnimationFrame(tick);
  }

  function refreshQuestionStylesAfterConfigChange() {
    if (!isQuestionStylesEnabled()) return;
    restoreQuestionStyles();
    if (applyQuestionStyles()) runQuestionStylesBurst(4);
    setTimeout(() => {
      if (isQuestionStylesEnabled()) applyQuestionStyles();
    }, 75);
  }

  function syncQuestionStyles() {
    if (!isQuestionStylesEnabled() || questionStylesState.syncQueued) return;
    questionStylesState.syncQueued = true;
    questionStylesState.syncFrameId = requestAnimationFrame(() => {
      questionStylesState.syncFrameId = null;
      questionStylesState.syncQueued = false;
      if (!isQuestionStylesEnabled()) return;
      if (applyQuestionStyles()) runQuestionStylesBurst(2);
    });
  }


  function isStylesSettingId(settingId) {
    return typeof settingId === "string" && Object.prototype.hasOwnProperty.call(QUESTION_STYLES_DEFAULTS, settingId);
  }

  function syncStylesConfigControl(control) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return false;
    const settingId = control.dataset?.settingId;
    if (!isStylesSettingId(settingId)) return false;
    const cfg = getStylesConfigStore();
    if (!cfg) return false;
    if (control instanceof HTMLInputElement && control.type === "checkbox") cfg[settingId] = Boolean(control.checked);
    else if (control instanceof HTMLInputElement && control.type === "range") cfg[settingId] = Number(control.value);
    else cfg[settingId] = String(control.value ?? "");
    refreshQuestionStylesAfterConfigChange();
    if (typeof saveSettings === "function") saveSettings();
    return true;
  }

  function attachStylesConfigLiveSync(targetBody) {
    if (!(targetBody instanceof HTMLElement)) return;
    targetBody.__anrrgmStylesConfigAbort?.abort?.();
    const controller = new AbortController();
    targetBody.__anrrgmStylesConfigAbort = controller;
    const syncFromEvent = (event) => {
      const control = event.target?.closest?.("[data-setting-id]");
      if (!control) return;
      syncStylesConfigControl(control);
    };
    targetBody.addEventListener("input", syncFromEvent, { capture: true, signal: controller.signal });
    targetBody.addEventListener("change", syncFromEvent, { capture: true, signal: controller.signal });
  }

  function startQuestionStyles() {
    if (questionStylesState.observer) questionStylesState.observer.disconnect();
    const existingRoot = document.querySelector(QUESTION_STYLE_SCREEN_SELECTOR);
    if (existingRoot instanceof HTMLElement) questionStylesState.currentRoot = existingRoot;
    questionStylesState.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target instanceof HTMLElement) captureQuestionStyleRootFromNode(mutation.target);
        for (const node of mutation.addedNodes) captureQuestionStyleRootFromNode(node);
      }
      syncQuestionStyles();
    });
    const target = document.body || document.documentElement;
    if (target) questionStylesState.observer.observe(target, { childList: true, subtree: true });
    if (applyQuestionStyles()) runQuestionStylesBurst(4);
  }

  function stopQuestionStyles() {
    if (questionStylesState.observer) {
      questionStylesState.observer.disconnect();
      questionStylesState.observer = null;
    }
    if (questionStylesState.burstFrameId) {
      cancelAnimationFrame(questionStylesState.burstFrameId);
      questionStylesState.burstFrameId = null;
    }
    if (questionStylesState.syncFrameId) {
      cancelAnimationFrame(questionStylesState.syncFrameId);
      questionStylesState.syncFrameId = null;
    }
    questionStylesState.syncQueued = false;
    questionStylesState.burstFramesRemaining = 0;
    restoreQuestionStyles();
    questionStylesState.currentRoot = null;
  }

  const ABILITY_HUD_MODULE_NAME = "Ability HUD";
  const ABILITY_HUD_LOG = "[AbilityHUD]";
  const ABILITY_HUD_INTERNAL_OPACITY = 0.95;
  const ABILITY_HUD_INTERNAL_Z_INDEX = 2147483646;
  const ABILITY_HUD_DRAG_MARGIN = 10;
  const ABILITY_HUD_CONFIG_DEFAULTS = {
    // Switch between detailed card rows and compact icon tiles.
    abilityHudDisplayMode: "icons",
    // Scales the entire HUD UI (container + content).
    abilityHudScale: 0.9,
    // Gap spacing between icon tiles (pixels).
    abilityHudGap: 5,
    // Toggle price labels in both default + icon modes.
    abilityHudShowPrices: true,
    // Icon tile size (pixels).
    abilityHudIconSize: 96,
  };
  const abilityHudState = {
    enabled: false,
    container: null,
    body: null,
    abilities: new Map(),
    currentBalance: 0,
    roomId: null,
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    position: { x: null, y: null },
    renderTimerId: null,
    wired: false,
    listeners: null,
    packetLogCount: 0,
    purchasedAbilities: new Set(),
    usedAbilities: new Set(),
    pendingTargetAbility: null,
    pendingTargetRequestedAt: 0,
    selfPlayerId: null,
    isRichMode: false,
    specialGameTypes: [],
    config: { ...ABILITY_HUD_CONFIG_DEFAULTS },
    iconTiles: [],
  };

  function normalizeAbilityHudSpecialGameTypes(value) {
    const values = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return values.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean);
  }

  function extractAbilityHudGameOptions(packet) {
    return packet?.data?.gameOptions
      || packet?.payload?.data?.gameOptions
      || packet?.payload?.gameOptions
      || packet?.gameOptions
      || null;
  }

  function applyAbilityHudSpecialGameType(packet, target = abilityHudState) {
    const gameOptions = extractAbilityHudGameOptions(packet);
    const specialGameTypes = normalizeAbilityHudSpecialGameTypes(gameOptions?.specialGameType);
    if (!specialGameTypes.length) return false;
    target.specialGameTypes = specialGameTypes;
    target.isRichMode = specialGameTypes.includes("RICH");
    console.debug(`${ABILITY_HUD_LOG} special game type detected`, { specialGameTypes, isRichMode: target.isRichMode });
    return true;
  }

  const ABILITY_HUD_BLUEBOAT_CHANNELS = new Set([
    "POWERUP_PURCHASED",
    "POWERUP_ACTIVATED",
    "POWERUP_ATTACK",
    "PLAYER_LEADERBOARD_REQUESTED",
  ]);

  function sendAbilityHudMessage(channel, data) {
    const requiresBlueboat = abilityHudState.isRichMode || ABILITY_HUD_BLUEBOAT_CHANNELS.has(channel);
    if (requiresBlueboat) {
      const sent = socketManager.sendBlueboatMessage(channel, data);
      if (!sent) {
        console.warn(`${ABILITY_HUD_LOG} ability packet requires Blueboat but room id/socket is unavailable`, {
          channel,
          room: socketManager.blueboatRoomId,
          isRichMode: abilityHudState.isRichMode,
        });
      }
      return;
    }
    socketManager.sendMessage(channel, data);
  }

  function calculateAbilityCost(ability, playerState = {}) {
    const baseCost = Number(ability?.baseCost) || 0;
    const percentageCost = Number(ability?.percentageCost) || 0;
    const balance = Number(playerState?.balance) || 0;
    const rawCost = (percentageCost * balance) + baseCost;
    const roundedCost = Math.ceil(rawCost / 5) * 5;
    return { rawCost, roundedCost, displayCost: roundedCost };
  }

  function extractAbilitiesFromPacket(packet) {
    const containers = [
      packet?.data,
      packet?.payload?.data,
      packet?.payload,
      packet,
    ].filter(Boolean);

    for (const container of containers) {
      const direct = container?.powerups;
      if (Array.isArray(direct)) return direct;
      const fallback = container?.abilities;
      if (Array.isArray(fallback)) return fallback;
    }

    for (const container of containers) {
      if (!container || typeof container !== "object") continue;
      for (const value of Object.values(container)) {
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value?.powerups)) return value.powerups;
        if (Array.isArray(value?.abilities)) return value.abilities;
      }
    }

    return [];
  }

  function normalizeAbility(entry) {
    if (!entry || typeof entry !== "object") return null;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) return null;
    const displayName = typeof entry.displayName === "string" && entry.displayName.trim() ? entry.displayName.trim() : name;
    return {
      name,
      displayName,
      description: typeof entry.description === "string" ? entry.description : "",
      icon: typeof entry.icon === "string" ? entry.icon : "",
      color: {
        background: entry?.color?.background || "#2a2f3a",
        text: entry?.color?.text || "#ffffff",
      },
      baseCost: Number(entry.baseCost) || 0,
      percentageCost: Number(entry.percentageCost) || 0,
      disabled: Array.isArray(entry.disabled) ? entry.disabled.slice() : [],
    };
  }

  function requestAbilityHudRender() {
    if (!abilityHudState.enabled || !abilityHudState.container) return;
    if (abilityHudState.renderTimerId) clearTimeout(abilityHudState.renderTimerId);
    abilityHudState.renderTimerId = setTimeout(() => {
      abilityHudState.renderTimerId = null;
      renderAbilityHud();
    }, 35);
  }

  function getAbilityHudConfig() {
    const readModuleCfg = () => {
      if (typeof moduleCfg === "function") {
        try { return moduleCfg(ABILITY_HUD_MODULE_NAME); } catch (_) {}
      }
      return abilityHudState.config || ABILITY_HUD_CONFIG_DEFAULTS;
    };
    try {
      return getAbilityHudConfigFromRaw(readModuleCfg());
    } catch (_) {
      return getAbilityHudConfigFromRaw(abilityHudState.config || ABILITY_HUD_CONFIG_DEFAULTS);
    }
  }

  function getAbilityHudDefaultPosition(panelRect) {
    const inset = 18;
    const topInset = 116;
    const width = Math.max(100, panelRect?.width || 360);
    return { x: window.innerWidth - width - inset, y: topInset };
  }

  function clampAbilityHudPosition(x, y, panelRect) {
    const width = Math.max(100, panelRect?.width || 360);
    const height = Math.max(44, panelRect?.height || 120);
    const minX = ABILITY_HUD_DRAG_MARGIN;
    const minY = ABILITY_HUD_DRAG_MARGIN;
    const maxX = Math.max(minX, window.innerWidth - width - ABILITY_HUD_DRAG_MARGIN);
    const maxY = Math.max(minY, window.innerHeight - height - ABILITY_HUD_DRAG_MARGIN);
    return { x: Math.max(minX, Math.min(maxX, Number(x) || minX)), y: Math.max(minY, Math.min(maxY, Number(y) || minY)) };
  }

  function persistAbilityHudPosition() {
    try {
      const cfg = moduleCfg(ABILITY_HUD_MODULE_NAME);
      if (!cfg || typeof cfg !== "object") return;
      cfg.hudPosition = {
        x: Math.round(Number(abilityHudState.position.x) || 0),
        y: Math.round(Number(abilityHudState.position.y) || 0),
      };
      console.log("[HUD Position] Stored", { moduleName: ABILITY_HUD_MODULE_NAME, hudPosition: { ...cfg.hudPosition } });
      if (typeof saveSettings === "function") saveSettings();
    } catch (_) {}
  }

  function applyAbilityHudLiveConfig(opts = {}) {
    if (!abilityHudState.enabled) return;
    const cfg = opts.cfg && typeof opts.cfg === "object"
      ? getAbilityHudConfigFromRaw(opts.cfg)
      : getAbilityHudConfig();
    if (!abilityHudState.container) return;
    const panelRect = abilityHudState.container.getBoundingClientRect();
    const clamped = clampAbilityHudPosition(abilityHudState.position.x, abilityHudState.position.y, panelRect);
    abilityHudState.position.x = clamped.x;
    abilityHudState.position.y = clamped.y;
    abilityHudState.container.style.left = `${clamped.x}px`;
    abilityHudState.container.style.top = `${clamped.y}px`;
    abilityHudState.container.style.transformOrigin = "top left";
    abilityHudState.container.style.transform = `scale(${cfg.abilityHudScale})`;
    requestAbilityHudRender();
  }

  function getAbilityHudConfigFromRaw(rawCfg) {
    const mode = String(rawCfg?.abilityHudDisplayMode ?? ABILITY_HUD_CONFIG_DEFAULTS.abilityHudDisplayMode).trim().toLowerCase();
    abilityHudState.config.abilityHudDisplayMode = mode === "icons" ? "icons" : "list";
    abilityHudState.config.abilityHudScale = Math.max(0.75, Math.min(1.25, Number(rawCfg?.abilityHudScale) || ABILITY_HUD_CONFIG_DEFAULTS.abilityHudScale));
    abilityHudState.config.abilityHudGap = Math.max(1, Math.min(15, Number(rawCfg?.abilityHudGap) || ABILITY_HUD_CONFIG_DEFAULTS.abilityHudGap));
    abilityHudState.config.abilityHudShowPrices = parseBooleanSetting(rawCfg?.abilityHudShowPrices, ABILITY_HUD_CONFIG_DEFAULTS.abilityHudShowPrices);
    abilityHudState.config.abilityHudIconSize = Math.max(56, Math.min(164, Number(rawCfg?.abilityHudIconSize) || ABILITY_HUD_CONFIG_DEFAULTS.abilityHudIconSize));
    return { ...abilityHudState.config };
  }


  function getAbilityHudTextColor(hex) {
    const color = String(hex || "").trim();
    const match = color.match(/^#([0-9a-f]{6})$/i);
    if (!match) return "#ffffff";
    const raw = match[1];
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    return luminance > 160 ? "#0a111d" : "#ffffff";
  }

  function createAbilityTile(index) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.dataset.slotIndex = String(index);
    tile.style.cssText = "appearance:none;position:relative;display:grid;grid-template-rows:auto 1fr auto;align-items:center;justify-items:center;gap:4px;width:96px;height:96px;border-radius:16px;border:1px solid rgba(255,255,255,.24);padding:7px;box-sizing:border-box;cursor:pointer;overflow:hidden;background:#2a2f3a;color:#fff;box-shadow:inset 0 -12px 20px rgba(0,0,0,.18),0 5px 14px rgba(0,0,0,.24);";

    // Enforced order: title (top) -> icon (center) -> price (bottom), all inside tile.
    const title = document.createElement("div");
    title.className = "anrrgm-ability-title";
    title.style.cssText = "width:100%;text-align:center;font-size:11px;font-weight:800;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.02em;text-shadow:0 1px 2px rgba(0,0,0,.45);z-index:2;";
    const icon = document.createElement("div");
    icon.className = "anrrgm-ability-icon";
    icon.style.cssText = "display:flex;align-items:center;justify-content:center;width:44px;height:44px;min-width:44px;min-height:44px;max-width:44px;max-height:44px;font-size:29px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));z-index:2;overflow:hidden;";
    const iconImg = document.createElement("img");
    iconImg.className = "anrrgm-ability-icon-img";
    iconImg.alt = "";
    iconImg.style.cssText = "display:none;width:100%;height:100%;object-fit:contain;";
    const iconFallback = document.createElement("span");
    iconFallback.className = "anrrgm-ability-icon-fallback";
    iconFallback.textContent = "◻";
    const iconFa = document.createElement("i");
    iconFa.className = "anrrgm-ability-icon-fa";
    iconFa.setAttribute("aria-hidden", "true");
    iconFa.style.cssText = "display:none;font-size:28px;line-height:1;";
    icon.append(iconImg, iconFa, iconFallback);
    const price = document.createElement("div");
    price.className = "anrrgm-ability-price";
    price.style.cssText = "width:100%;text-align:center;font-size:11px;font-weight:800;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.45);z-index:2;";
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,.18),rgba(0,0,0,.07) 42%,rgba(0,0,0,.25));z-index:1;";
    tile.append(title, icon, price, overlay);
    return { tile, title, icon, iconImg, iconFa, iconFallback, price };
  }

  function updateAbilityTileData(slot, ability) {
    const fallbackBg = "#2a2f3a";
    const fallbackIcon = "◻";
    const abilityName = ability?.displayName || ability?.name || "Unknown";
    const iconText = fallbackIcon;
    const iconRaw = typeof ability?.icon === "string" ? ability.icon.trim() : "";
    const bg = ability?.color?.background || fallbackBg;
    const textColor = ability?.color?.text || getAbilityHudTextColor(bg);
    if (!ability) {
      slot.tile.disabled = true;
      slot.tile.style.cursor = "default";
      slot.tile.style.opacity = ".52";
      slot.tile.style.background = fallbackBg;
      slot.tile.style.borderColor = "rgba(255,255,255,.16)";
      slot.title.textContent = "Empty";
      slot.iconImg.style.display = "none";
      slot.iconImg.removeAttribute("src");
      slot.iconFa.style.display = "none";
      slot.iconFa.className = "anrrgm-ability-icon-fa";
      slot.iconFallback.style.display = "";
      slot.iconFallback.textContent = fallbackIcon;
      slot.price.textContent = "--";
      slot.title.style.color = "#d6dbea";
      slot.price.style.color = "#d6dbea";
      return;
    }
    const pricing = calculateAbilityCost(ability, { balance: abilityHudState.currentBalance });
    const alreadyPurchased = abilityHudState.purchasedAbilities.has(ability.name);
    const alreadyUsed = abilityHudState.usedAbilities.has(ability.name);
    const canAfford = abilityHudState.currentBalance >= pricing.roundedCost;
    const isTooExpensive = !alreadyPurchased && !canAfford;
    const disabled = alreadyUsed || isTooExpensive;
    slot.tile.disabled = disabled;
    slot.tile.style.opacity = alreadyUsed ? ".58" : (isTooExpensive ? ".68" : "1");
    slot.tile.style.cursor = disabled ? "default" : "pointer";
    slot.tile.style.background = bg;
    slot.tile.style.borderColor = alreadyUsed
      ? "rgba(140,146,160,.38)"
      : (isTooExpensive ? "rgba(172,158,128,.42)" : "rgba(255,255,255,.34)");
    slot.tile.style.filter = alreadyUsed
      ? "grayscale(0.7) saturate(0.45) brightness(0.74)"
      : (isTooExpensive ? "grayscale(0.45) saturate(0.6) brightness(0.8)" : "none");
    slot.title.textContent = abilityName;
    slot.title.title = abilityName;
    slot.title.style.color = textColor;
    slot.title.style.fontSize = abilityName.length > 14 ? "9px" : "11px";
    slot.icon.style.color = textColor;
    const isLikelyImage = /^https?:\/\//i.test(iconRaw) || /^data:image\//i.test(iconRaw) || iconRaw.startsWith("/");
    const isLikelyFaClass = /\bfa[srbld]?\b/i.test(iconRaw) || /\bfa-[a-z0-9-]+\b/i.test(iconRaw);
    if (isLikelyImage) {
      slot.iconImg.src = iconRaw;
      slot.iconImg.style.display = "";
      slot.iconFa.style.display = "none";
      slot.iconFa.className = "anrrgm-ability-icon-fa";
      slot.iconFallback.style.display = "none";
    } else if (isLikelyFaClass) {
      slot.iconImg.style.display = "none";
      slot.iconImg.removeAttribute("src");
      slot.iconFa.className = `anrrgm-ability-icon-fa ${iconRaw}`.trim();
      slot.iconFa.style.display = "";
      slot.iconFallback.style.display = "none";
    } else {
      slot.iconImg.style.display = "none";
      slot.iconImg.removeAttribute("src");
      slot.iconFa.style.display = "none";
      slot.iconFa.className = "anrrgm-ability-icon-fa";
      slot.iconFallback.style.display = "";
      slot.iconFallback.textContent = iconText;
    }
    slot.iconFa.style.color = textColor;
    slot.iconFallback.style.color = textColor;
    const dimText = alreadyUsed ? "rgba(230,234,242,.95)" : (isTooExpensive ? "rgba(244,235,210,.95)" : textColor);
    slot.title.style.color = dimText;
    slot.icon.style.color = dimText;
    slot.iconFa.style.color = dimText;
    slot.iconFallback.style.color = dimText;
    const outlineShadow = alreadyUsed
      ? "0 1px 0 rgba(0,0,0,.8), 0 0 2px rgba(0,0,0,.7), 0 0 6px rgba(110,120,140,.45)"
      : (isTooExpensive ? "0 1px 0 rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.72), 0 0 6px rgba(184,152,86,.38)" : "0 1px 2px rgba(0,0,0,.45)");
    slot.title.style.textShadow = outlineShadow;
    slot.price.style.textShadow = outlineShadow;
    slot.icon.style.filter = alreadyUsed
      ? "drop-shadow(0 1px 1px rgba(0,0,0,.85)) drop-shadow(0 0 6px rgba(120,130,150,.38))"
      : (isTooExpensive ? "drop-shadow(0 1px 1px rgba(0,0,0,.88)) drop-shadow(0 0 6px rgba(191,150,76,.3))" : "drop-shadow(0 2px 3px rgba(0,0,0,.4))");
    const showPrices = abilityHudState.config.abilityHudShowPrices !== false;
    slot.price.textContent = showPrices ? (alreadyUsed ? "Used" : (alreadyPurchased ? "Use" : `$${pricing.roundedCost || 0}`)) : "";
    slot.price.style.display = showPrices ? "" : "none";
    slot.price.style.color = textColor;
    slot.tile.onclick = () => {
      if (alreadyPurchased) sendAbilityUse(ability);
      else sendAbilityPurchase(ability);
    };
  }

  function renderAbilityHudIcons(entries) {
    if (!abilityHudState.body) return;
    let row = abilityHudState.body.querySelector(".anrrgm-ability-icon-row");
    if (!row) {
      abilityHudState.body.innerHTML = "";
      row = document.createElement("div");
      row.className = "anrrgm-ability-icon-row";
      row.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,96px));gap:8px;justify-content:start;align-items:start;pointer-events:auto;width:max-content;";
      abilityHudState.body.appendChild(row);
      abilityHudState.iconTiles = [];
    }

    const slotCount = Math.max(3, entries.length);
    while (abilityHudState.iconTiles.length < slotCount) {
      const slot = createAbilityTile(abilityHudState.iconTiles.length);
      abilityHudState.iconTiles.push(slot);
      row.appendChild(slot.tile);
    }
    while (abilityHudState.iconTiles.length > slotCount) {
      const slot = abilityHudState.iconTiles.pop();
      slot?.tile?.remove();
    }

    const iconSize = abilityHudState.config.abilityHudIconSize;
    row.style.gap = `${abilityHudState.config.abilityHudGap}px`;
    for (let i = 0; i < slotCount; i += 1) {
      const slot = abilityHudState.iconTiles[i];
      if (slot?.tile) { slot.tile.style.width = `${iconSize}px`; slot.tile.style.height = `${iconSize}px`; }
      updateAbilityTileData(slot, entries[i] || null);
    }
  }

  function onAbilityHudInbound(event) {
    const packet = event?.detail;
    const key = packet?.key ?? packet?.payload?.key;
    if (key === "PLAYER_JOINS_STATIC_STATE") {
      applyAbilityHudSpecialGameType(packet);
      abilityHudState.purchasedAbilities.clear();
      abilityHudState.usedAbilities.clear();
    }
    if (abilityHudState.packetLogCount < 18) {
      abilityHudState.packetLogCount += 1;
      console.debug(`${ABILITY_HUD_LOG} inbound packet`, {
        key,
        eventName: packet?.eventName,
        hasData: Boolean(packet?.data),
        dataKeys: packet?.data && typeof packet.data === "object" ? Object.keys(packet.data).slice(0, 12) : [],
      });
    }
    if (key === "PLAYER_JOINS_STATIC_STATE") {
      console.debug(`${ABILITY_HUD_LOG} static join packet intercepted`);
    }
    if (key === "STATE_UPDATE") {
      const type = packet?.data?.type ?? packet?.payload?.data?.type;
      if (type === "BALANCE") {
        const balance = Number(packet?.data?.value ?? packet?.payload?.data?.value);
        if (Number.isFinite(balance)) {
          abilityHudState.currentBalance = balance;
          requestAbilityHudRender();
        }
      }
      if (type === "PURCHASED_POWERUPS" || type === "USED_POWERUPS") {
        const list = packet?.data?.value ?? packet?.payload?.data?.value;
        if (Array.isArray(list)) {
          const targetSet = type === "PURCHASED_POWERUPS" ? abilityHudState.purchasedAbilities : abilityHudState.usedAbilities;
          let changed = false;
          for (const entry of list) {
            const abilityName = typeof entry === "string" ? entry.trim() : "";
            if (!abilityName) continue;
            if (!targetSet.has(abilityName)) {
              targetSet.add(abilityName);
              changed = true;
            }
          }
          if (changed) requestAbilityHudRender();
        }
      }
    }
    if (packet?.eventName === "CLIENT_ID_SET") {
      const selfPlayerId = packet?.payload ?? packet?.data ?? null;
      if (typeof selfPlayerId === "string" && selfPlayerId.trim()) {
        abilityHudState.selfPlayerId = selfPlayerId.trim();
        console.debug(`${ABILITY_HUD_LOG} captured self player id from CLIENT_ID_SET`, { selfPlayerId: abilityHudState.selfPlayerId });
      }
    }
    if (key === "UPDATED_PLAYER_LEADERBOARD") {
      const pendingAbility = abilityHudState.pendingTargetAbility;
      const items = packet?.data?.items ?? packet?.payload?.data?.items;
      const rawPlayers = Array.isArray(items) ? items.filter((item) => item && item.id) : [];
      const players = rawPlayers.filter((item) => item.id !== abilityHudState.selfPlayerId);
      console.debug(`${ABILITY_HUD_LOG} [Step 3] received leaderboard packet`, {
        hasPendingAbility: Boolean(pendingAbility),
        selfPlayerId: abilityHudState.selfPlayerId,
        itemCountRaw: rawPlayers.length,
        itemCountFiltered: players.length,
      });
      if (pendingAbility && players.length) {
        openTargetSelectionMenu(pendingAbility, players);
      }
    }
    const abilities = extractAbilitiesFromPacket(packet);
    if (!abilities.length) {
      if (key === "PLAYER_JOINS_STATIC_STATE" || key === "STATE_UPDATE") {
        console.debug(`${ABILITY_HUD_LOG} no abilities extracted`, {
          key,
          probe: {
            hasDataPowerups: Array.isArray(packet?.data?.powerups),
            hasPayloadDataPowerups: Array.isArray(packet?.payload?.data?.powerups),
            hasPayloadPowerups: Array.isArray(packet?.payload?.powerups),
          },
        });
      }
      return;
    }
    console.debug(`${ABILITY_HUD_LOG} extracted abilities`, { key, count: abilities.length });
    let changed = false;
    for (const rawAbility of abilities) {
      const normalized = normalizeAbility(rawAbility);
      if (!normalized) continue;
      abilityHudState.abilities.set(normalized.name, normalized);
      changed = true;
      if (normalized.name === "Icer" || normalized.displayName === "Freezer") {
        console.debug(`${ABILITY_HUD_LOG} freeze mapping`, { displayName: normalized.displayName, purchaseName: normalized.name });
      }
    }
    if (changed) requestAbilityHudRender();
  }

  function onAbilityHudOutbound(event) {
    const packet = event?.detail;
    const key = packet?.key ?? packet?.payload?.key;
    if (key !== "POWERUP_PURCHASED" && key !== "POWERUP_ACTIVATED") return;
    const payload = packet?.payload || packet;
    console.debug(`${ABILITY_HUD_LOG} outbound powerup observed`, payload);
  }

  function sendAbilityPurchase(ability) {
    if (!ability?.name) return;
    if (abilityHudState.purchasedAbilities.has(ability.name) || abilityHudState.usedAbilities.has(ability.name)) return;
    const pricing = calculateAbilityCost(ability, { balance: abilityHudState.currentBalance });
    if (abilityHudState.currentBalance < pricing.roundedCost) return;
    const payload = { room: socketManager.blueboatRoomId, key: "POWERUP_PURCHASED", data: ability.name };
    console.debug(`${ABILITY_HUD_LOG} sending purchase payload`, payload);
    if (ability.name === "Icer") {
      console.debug(`${ABILITY_HUD_LOG} ASSERT freeze mapping ok: display="${ability.displayName}" payload="${ability.name}"`);
    }
    sendAbilityHudMessage("POWERUP_PURCHASED", ability.name);
    abilityHudState.purchasedAbilities.add(ability.name);
    requestAbilityHudRender();
  }

  function isRebooterAbility(ability) {
    const name = String(ability?.name || "").trim().toLowerCase();
    const displayName = String(ability?.displayName || "").trim().toLowerCase();
    return name === "repurchasepowerups" || displayName === "rebooter";
  }

  function abilityRequiresTargetSelection(ability) {
    if (!ability || !Array.isArray(ability.disabled)) return false;
    const isShield = String(ability?.name || "").trim().toLowerCase() === "shield";
    const isGiftAbility = String(ability?.name || "").trim().toLowerCase() === "giving"
      || String(ability?.displayName || "").trim().toLowerCase() === "gift";
    const requires = (!isShield && ability.disabled.some((flag) => String(flag || "").trim() === "cleanOnly")) || isGiftAbility;
    console.debug(`${ABILITY_HUD_LOG} [Step 1] ability target-selection requirement`, {
      abilityName: ability?.name,
      disabledFlags: ability?.disabled,
      requiresTargetSelection: requires,
    });
    return requires;
  }

  function requestLeaderboardForAbilityTarget(ability) {
    const roomId = socketManager.blueboatRoomId;
    if (!roomId) {
      console.warn(`${ABILITY_HUD_LOG} [Step 2] missing room id; cannot request leaderboard`, { abilityName: ability?.name });
      return;
    }
    abilityHudState.pendingTargetAbility = ability;
    abilityHudState.pendingTargetRequestedAt = Date.now();
    const payload = { room: roomId, key: "PLAYER_LEADERBOARD_REQUESTED", data: null };
    console.debug(`${ABILITY_HUD_LOG} [Step 2] requesting leaderboard for target selection`, payload);
    sendAbilityHudMessage("PLAYER_LEADERBOARD_REQUESTED", null);
  }

  function openTargetSelectionMenu(ability, players) {
    console.debug(`${ABILITY_HUD_LOG} [Step 3] opening target selection menu`, {
      abilityName: ability?.name,
      playerCount: players.length,
      players,
    });
    const existing = document.getElementById("anrrgm-target-menu");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "anrrgm-target-menu";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;";
    const panel = document.createElement("div");
    panel.style.cssText = "width:min(360px,calc(100vw - 20px));max-height:min(80vh,520px);overflow:auto;background:#121722;border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:10px;font-family:Inter,system-ui,sans-serif;color:#fff;";
    const title = document.createElement("div");
    title.textContent = `Select target for ${ability.displayName || ability.name}`;
    title.style.cssText = "font-size:14px;font-weight:700;margin-bottom:8px;";
    panel.appendChild(title);
    players.forEach((player) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${player.name || "Unknown"}`;
      btn.style.cssText = "display:block;width:100%;text-align:left;margin:0 0 6px 0;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;";
      btn.addEventListener("click", () => {
        overlay.remove();
        sendTargetedAbilityUse(ability, player.id);
      });
      panel.appendChild(btn);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "display:block;width:100%;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,0,0,.2);color:#fff;cursor:pointer;";
    cancel.addEventListener("click", () => {
      console.debug(`${ABILITY_HUD_LOG} [Step 3] target selection canceled`, { abilityName: ability?.name });
      abilityHudState.pendingTargetAbility = null;
      overlay.remove();
    });
    panel.appendChild(cancel);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  function sendTargetedAbilityUse(ability, targetId) {
    const roomId = socketManager.blueboatRoomId;
    if (!roomId || !ability?.name || !targetId) return;
    const data = { name: ability.name, target: targetId };
    const payload = { room: roomId, key: "POWERUP_ATTACK", data };
    console.debug(`${ABILITY_HUD_LOG} [Step 4] sending targeted ability payload`, payload);
    sendAbilityHudMessage("POWERUP_ATTACK", data);
    abilityHudState.usedAbilities.add(ability.name);
    abilityHudState.pendingTargetAbility = null;
    requestAbilityHudRender();
  }

  function sendAbilityUse(ability) {
    if (!ability?.name) return;
    if (abilityHudState.usedAbilities.has(ability.name)) return;
    const activatePayload = { room: socketManager.blueboatRoomId, key: "POWERUP_ACTIVATED", data: ability.name };
    console.debug(`${ABILITY_HUD_LOG} [Step 0] sending regular activate payload`, activatePayload);
    sendAbilityHudMessage("POWERUP_ACTIVATED", ability.name);

    if (abilityRequiresTargetSelection(ability)) {
      requestLeaderboardForAbilityTarget(ability);
      return;
    }

    if (isRebooterAbility(ability)) {
      console.debug(`${ABILITY_HUD_LOG} rebooter activated; clearing USED state while preserving PURCHASED state`);
      abilityHudState.usedAbilities.clear();
      abilityHudState.usedAbilities.add(ability.name);
      requestAbilityHudRender();
      return;
    }

    abilityHudState.usedAbilities.add(ability.name);
    requestAbilityHudRender();
  }

  function renderAbilityHud() {
    if (!abilityHudState.body) return;
    const entries = Array.from(abilityHudState.abilities.values());
    const cfg = getAbilityHudConfig();
    if (abilityHudState.container) {
      abilityHudState.container.style.transformOrigin = "top left";
      abilityHudState.container.style.transform = `scale(${cfg.abilityHudScale})`;
    }
    if (!entries.length) {
      abilityHudState.body.innerHTML = `<div style="font-size:12px;color:#b3b9c7;opacity:.85;">Waiting for abilities…</div>`;
      return;
    }
    if (cfg.abilityHudDisplayMode === "icons") {
      if (abilityHudState.container) {
        abilityHudState.container.style.width = "fit-content";
      }
      if (abilityHudState.body) {
        abilityHudState.body.style.width = "fit-content";
      }
      renderAbilityHudIcons(entries);
      return;
    }
    if (abilityHudState.container) abilityHudState.container.style.width = "min(360px,calc(100vw - 24px))";
    if (abilityHudState.body) abilityHudState.body.style.width = "";
    const frag = document.createDocumentFragment();
    for (const ability of entries) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 7px;border-radius:9px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);";
      const abilityDescription = typeof ability.description === "string" && ability.description.trim() ? ability.description.trim() : "No description available.";
      wrap.title = abilityDescription;
      const info = document.createElement("div");
      info.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;flex:1;";
      const name = document.createElement("div");
      name.style.cssText = "font-size:12px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      name.textContent = ability.displayName;
      name.title = abilityDescription;
      const pricing = calculateAbilityCost(ability, { balance: abilityHudState.currentBalance });
      const canAfford = abilityHudState.currentBalance >= pricing.roundedCost;
      const showPrices = abilityHudState.config.abilityHudShowPrices !== false;
      info.append(name);
      const buyBtn = document.createElement("button");
      buyBtn.type = "button";
      const alreadyPurchased = abilityHudState.purchasedAbilities.has(ability.name);
      const alreadyUsed = abilityHudState.usedAbilities.has(ability.name);
      const disabled = alreadyUsed || (!alreadyPurchased && !canAfford);
      buyBtn.disabled = disabled;
      buyBtn.textContent = alreadyUsed
        ? "Used"
        : (alreadyPurchased ? "Use" : (showPrices ? `$${pricing.roundedCost}` : "Buy"));
      const isUsed = alreadyUsed;
      const isUnavailable = !alreadyPurchased && !canAfford;
      const buttonBorder = isUsed ? "rgba(160,160,160,.42)" : (isUnavailable ? "rgba(255,255,255,.24)" : "rgba(46,204,113,.82)");
      const buttonBg = isUsed ? "rgba(120,120,120,.36)" : (isUnavailable ? "rgba(255,255,255,.09)" : "rgba(46,204,113,.35)");
      const buttonColor = isUsed ? "rgba(230,230,230,.9)" : "#fff";
      buyBtn.className = "anrrgm-upgrade-hud-button";
      buyBtn.style.cssText = `appearance:none;border:1px solid ${buttonBorder};background:${buttonBg};color:${buttonColor};border-radius:6px;padding:5px 10px;font-size:12px;font-weight:700;line-height:1;cursor:${disabled ? "default" : "pointer"};width:96px;min-width:96px;max-width:96px;text-align:center;opacity:${isUsed ? ".9" : (disabled ? ".72" : "1")};`;
      buyBtn.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });
      buyBtn.addEventListener("click", () => {
        if (alreadyPurchased) sendAbilityUse(ability);
        else sendAbilityPurchase(ability);
      });
      wrap.append(info, buyBtn);
      frag.appendChild(wrap);
    }
    abilityHudState.body.innerHTML = "";
    abilityHudState.body.appendChild(frag);
  }

  function startAbilityHud() {
    if (abilityHudState.enabled) return;
    abilityHudState.enabled = true;
    getAbilityHudConfig();
    if (!abilityHudState.wired) {
      abilityHudState.listeners = {
        inbound: (event) => onAbilityHudInbound(event),
        outbound: (event) => onAbilityHudOutbound(event),
      };
      socketManager.addEventListener("blueboatMessage", abilityHudState.listeners.inbound);
      socketManager.addEventListener("blueboatSend", abilityHudState.listeners.outbound);
      abilityHudState.wired = true;
    }
    const cfg = getAbilityHudConfig();
    const savedPos = readHudPosition(ABILITY_HUD_MODULE_NAME, null);
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
      abilityHudState.position.x = savedPos.x;
      abilityHudState.position.y = savedPos.y;
      console.debug(`${ABILITY_HUD_LOG} restored HUD position`, { saved: savedPos });
    }
    if (!Number.isFinite(abilityHudState.position.x) || !Number.isFinite(abilityHudState.position.y)) {
      const position = getAbilityHudDefaultPosition({ width: 360, height: 120 });
      abilityHudState.position.x = position.x;
      abilityHudState.position.y = position.y;
      console.debug(`${ABILITY_HUD_LOG} no saved HUD position; using default`, { position });
    }
    const panel = document.createElement("section");
    panel.style.cssText = `position:fixed;left:${abilityHudState.position.x}px;top:${abilityHudState.position.y}px;z-index:${ABILITY_HUD_INTERNAL_Z_INDEX};width:min(360px,calc(100vw - 24px));background:linear-gradient(170deg,rgba(17,21,30,${ABILITY_HUD_INTERNAL_OPACITY}),rgba(8,10,16,${ABILITY_HUD_INTERNAL_OPACITY}));border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px;box-shadow:0 14px 34px rgba(0,0,0,.5);font-family:Inter,system-ui,sans-serif;cursor:grab;user-select:none;`;
    const head = document.createElement("header");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:4px 4px 8px 4px;border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:8px;";
    head.innerHTML = `<div style="font-size:12px;font-weight:800;color:#fff;letter-spacing:.06em;">ABILITY HUD</div>`;
    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;gap:5px;";
    panel.append(head, body);
    abilityHudState.container = panel;
    abilityHudState.body = body;
    document.documentElement.appendChild(panel);
    const clampedStart = clampAbilityHudPosition(abilityHudState.position.x, abilityHudState.position.y, panel.getBoundingClientRect());
    abilityHudState.position.x = clampedStart.x;
    abilityHudState.position.y = clampedStart.y;
    panel.style.left = `${clampedStart.x}px`;
    panel.style.top = `${clampedStart.y}px`;
    writeHudPosition(ABILITY_HUD_MODULE_NAME, clampedStart);
    console.debug(`${ABILITY_HUD_LOG} applied HUD position`, { applied: clampedStart });
    applyAbilityHudLiveConfig({ cfg });
    renderAbilityHud();
    panel.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target?.closest?.("button")) return;
      abilityHudState.isDragging = true;
      abilityHudState.dragOffsetX = event.clientX - panel.offsetLeft;
      abilityHudState.dragOffsetY = event.clientY - panel.offsetTop;
      panel.style.cursor = "grabbing";
      event.preventDefault();
    });
    document.addEventListener("mousemove", abilityHudMouseMove);
    document.addEventListener("mouseup", abilityHudMouseUp);
    if (abilityHudBootstrap.latestPacket) {
      console.debug(`${ABILITY_HUD_LOG} hydrating from bootstrap cache`);
      onAbilityHudInbound({ detail: abilityHudBootstrap.latestPacket });
    }
    if (Number.isFinite(abilityHudBootstrap.latestBalance)) {
      abilityHudState.currentBalance = Number(abilityHudBootstrap.latestBalance) || 0;
    }
    if (abilityHudBootstrap.purchasedAbilities.size) {
      abilityHudState.purchasedAbilities = new Set(abilityHudBootstrap.purchasedAbilities);
    }
    if (abilityHudBootstrap.usedAbilities.size) {
      abilityHudState.usedAbilities = new Set(abilityHudBootstrap.usedAbilities);
    }
    if (abilityHudBootstrap.selfPlayerId) {
      abilityHudState.selfPlayerId = abilityHudBootstrap.selfPlayerId;
    }
    abilityHudState.isRichMode = Boolean(abilityHudBootstrap.isRichMode);
    abilityHudState.specialGameTypes = Array.isArray(abilityHudBootstrap.specialGameTypes) ? [...abilityHudBootstrap.specialGameTypes] : [];
    requestAbilityHudRender();
  }

  function abilityHudMouseMove(event) {
    if (!abilityHudState.isDragging || !abilityHudState.container) return;
    const rect = abilityHudState.container.getBoundingClientRect();
    const clamped = clampAbilityHudPosition(event.clientX - abilityHudState.dragOffsetX, event.clientY - abilityHudState.dragOffsetY, rect);
    abilityHudState.position.x = clamped.x;
    abilityHudState.position.y = clamped.y;
    abilityHudState.container.style.left = `${abilityHudState.position.x}px`;
    abilityHudState.container.style.top = `${abilityHudState.position.y}px`;
    writeHudPosition(ABILITY_HUD_MODULE_NAME, { x: Math.round(clamped.x), y: Math.round(clamped.y) });
  }

  function abilityHudMouseUp() {
    abilityHudState.isDragging = false;
    if (abilityHudState.container) abilityHudState.container.style.cursor = "grab";
    writeHudPosition(ABILITY_HUD_MODULE_NAME, abilityHudState.position);
    persistAbilityHudPosition();
  }

  function stopAbilityHud() {
    abilityHudState.enabled = false;
    if (abilityHudState.container) {
      abilityHudState.container.remove();
      abilityHudState.container = null;
      abilityHudState.body = null;
      abilityHudState.iconTiles = [];
    }
    if (abilityHudState.renderTimerId) {
      clearTimeout(abilityHudState.renderTimerId);
      abilityHudState.renderTimerId = null;
    }
    document.removeEventListener("mousemove", abilityHudMouseMove);
    document.removeEventListener("mouseup", abilityHudMouseUp);
  }

  const abilityHudBootstrap = {
    latestPacket: null,
    latestBalance: 0,
    purchasedAbilities: new Set(),
    usedAbilities: new Set(),
    selfPlayerId: null,
    isRichMode: false,
    specialGameTypes: [],
  };

  socketManager.addEventListener("blueboatMessage", (event) => {
    const packet = event?.detail;
    const key = packet?.key ?? packet?.payload?.key;

    if (packet?.eventName === "CLIENT_ID_SET") {
      const selfPlayerId = packet?.payload ?? packet?.data ?? null;
      if (typeof selfPlayerId === "string" && selfPlayerId.trim()) {
        abilityHudBootstrap.selfPlayerId = selfPlayerId.trim();
      }
    }

    if (!key) return;
    if (key === "PLAYER_JOINS_STATIC_STATE") {
      abilityHudBootstrap.latestPacket = packet;
      applyAbilityHudSpecialGameType(packet, abilityHudBootstrap);
      abilityHudBootstrap.usedAbilities.clear();
      const count = Array.isArray(packet?.data?.powerups) ? packet.data.powerups.length : 0;
      console.debug(`${ABILITY_HUD_LOG} bootstrap captured static state`, { count });
      return;
    }
    if (key === "STATE_UPDATE") {
      const type = packet?.data?.type ?? packet?.payload?.data?.type;
      if (type === "BALANCE") {
        const value = Number(packet?.data?.value ?? packet?.payload?.data?.value);
        if (Number.isFinite(value)) abilityHudBootstrap.latestBalance = value;
      }
      if (type === "PURCHASED_POWERUPS" || type === "USED_POWERUPS") {
        const list = packet?.data?.value ?? packet?.payload?.data?.value;
        if (Array.isArray(list)) {
          const targetSet = type === "PURCHASED_POWERUPS" ? abilityHudBootstrap.purchasedAbilities : abilityHudBootstrap.usedAbilities;
          targetSet.clear();
          for (const item of list) {
            const name = typeof item === "string" ? item.trim() : "";
            if (name) targetSet.add(name);
          }
        }
      }
      if (!abilityHudBootstrap.latestPacket) {
        abilityHudBootstrap.latestPacket = packet;
      }
    }
  });

  const MODULE_BEHAVIORS = {
    [ANIMATION_SKIP_MODULE_NAME]: {
      onEnable: startAnimationSkip,
      onDisable: stopAnimationSkip,
    },
    [GAME_FINDER_MODULE_NAME]: {
      onEnable: startGameFinder,
      onDisable: stopGameFinder,
    },
    "ESP": {
      onEnable: startEsp,
      onDisable: stopEsp,
    },
    "Crosshair": {
      onEnable: startCrosshair,
      onDisable: stopCrosshair,
    },
    "Triggerbot (Autoshoot)": {
      onEnable: startTriggerAssist,
      onDisable: stopTriggerAssist,
    },
    "Quick Fire": {
      onEnable: startQuickFire,
      onDisable: stopQuickFire,
    },
    "Aimbot": {
      onEnable: startAutoAim,
      onDisable: stopAutoAim,
    },
    "Answer Popup": {
      onEnable: startAnswerPopup,
      onDisable: stopAnswerPopup,
    },
    "Upgrade HUD": {
      onEnable: startUpgradeHud,
      onDisable: stopUpgradeHud,
    },
    "Auto Upgrade": {
      onEnable: startAutoUpgrade,
      onDisable: stopAutoUpgrade,
    },
    "Building HUD": {
      onEnable: startLavaBuildingHud,
      onDisable: stopLavaBuildingHud,
    },
    [ABILITY_HUD_MODULE_NAME]: {
      onEnable: startAbilityHud,
      onDisable: stopAbilityHud,
    },
    "Answer Reveal": {
      onEnable: startDrawItAnswerReveal,
      onDisable: stopDrawItAnswerReveal,
    },
    [CAMERA_ZOOM_MODULE_NAME]: {
      onEnable: startCameraZoom,
      onDisable: stopCameraZoom,
    },
    [HIDE_POPUPS_MODULE_NAME]: {
      onEnable: startHidePopups,
      onDisable: stopHidePopups,
    },
    [ANTI_AFK_MODULE_NAME]: {
      onEnable: startAntiAfk,
      onDisable: stopAntiAfk,
    },
    [STYLES_MODULE_NAME]: {
      onEnable: startQuestionStyles,
      onDisable: stopQuestionStyles,
    },
    "Keystrokes": {
      onEnable: startKeystrokes,
      onDisable: stopKeystrokes,
    },
  };
  const MODULE_DESCRIPTIONS = {
    "Auto Answer": "Automatically submits the best answer after a delay.",
    [GAME_FINDER_MODULE_NAME]: "Adds a button next to the game code field that tries random Gimkit join codes and fills in the first active code it finds.",
    [ANIMATION_SKIP_MODULE_NAME]: "Skips most UI/menu animations (CSS + Web Animations API) so interfaces appear instantly.",
    "ESP": "Shows players with tracers, names, and off-screen indicators.",
    "Crosshair": "Draws a customizable crosshair and optional center line.",
    "Triggerbot (Autoshoot)": "Fires automatically when an enemy is in your aim radius.",
    "Quick Fire": "Rapidly fires toward your cursor; enable Always fire to shoot without holding left click.",
    "Aimbot": "Smoothly snaps your aim to nearby enemy players.",
    "Answer Reveal": "Reveals Draw It prompts/answers inside the drawing round.",
    "Answer Popup": "Displays detected Draw It answers in a popup.",
    "Upgrade HUD": "Shows Classic/Tycoon upgrade levels in a configurable HUD.",
    "Auto Upgrade": "Automatically buys the cheapest available Classic/Tycoon upgrade.",
    "Building HUD": "Shows Floor is Lava build costs and lets you buy builds quickly.",
    [ABILITY_HUD_MODULE_NAME]: "Shows intercepted abilities with live Classic/Tycoon pricing and one-click purchases.",
    [CAMERA_ZOOM_MODULE_NAME]: "Adjust how much you can see on the screen",
    [HIDE_POPUPS_MODULE_NAME]: "Hides Floor is Lava building purchase toasts and energy/resource popups.",
    [ANTI_AFK_MODULE_NAME]: "Sends lightweight synthetic activity pulses to reduce AFK kicks.",
    [STYLES_MODULE_NAME]: "Customizes question and answer colors on Gimkit question screens.",
    "Keystrokes": "Shows WASD, mouse buttons, CPS, and space bar input in a Minecraft-style overlay.",
  };

  // --- End of Core Utilities ---

  const MENU_LAYOUT = {
    general: {
      title: "General",
      groups: [
        {
          name: "Core",
          modules: [
            {
              name: "Auto Answer",
              description: MODULE_DESCRIPTIONS["Auto Answer"],
              settings: [
                { id: "speed", label: "Answer Delay", type: "slider", min: 200, max: 3000, step: 50, default: 1000 },
                { id: "triviaDelay", label: "Trivia Answer Delay", type: "slider", min: 0, max: 8000, step: 50, default: 1500 },
              ],
            },
            {
              name: GAME_FINDER_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[GAME_FINDER_MODULE_NAME],
              settings: [
                { id: "delay", label: "Delay", type: "slider", min: GAME_FINDER_MIN_DELAY_MS, max: GAME_FINDER_MAX_DELAY_MS, step: 1, default: GAME_FINDER_DEFAULT_DELAY_MS, unit: "ms" },
                { id: "concurrency", label: "Threads", type: "slider", min: GAME_FINDER_MIN_CONCURRENCY, max: GAME_FINDER_MAX_CONCURRENCY, step: 1, default: GAME_FINDER_DEFAULT_CONCURRENCY, unit: "" },
              ],
            },
            {
              name: ANTI_AFK_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[ANTI_AFK_MODULE_NAME],
              settings: [
                { id: "pulseMs", label: "Activity Pulse", type: "slider", min: 4000, max: 45000, step: 500, default: 12000 },
              ],
            },
          ],
        },
        {
          name: "Visual",
          modules: [
            {
              name: "ESP",
              description: MODULE_DESCRIPTIONS["ESP"],
              settings: [
                { id: "hitbox", label: "Hitbox", type: "checkbox", default: true },
                { id: "hitboxSize", label: "Hitbox Size", type: "slider", min: 24, max: 270, step: 2, default: 150, unit: "px" },
                { id: "hitboxWidth", label: "Hitbox Width", type: "slider", min: 1, max: 10, step: 1, default: 3, unit: "px" },
                { id: "hitboxColor", label: "Hitbox Color", type: "color", default: "#ff3b3b" },
                { id: "names", label: "Names", type: "checkbox", default: true },
                { id: "namesDistanceOnly", label: "Distance Only", type: "checkbox", default: false },
                { id: "nameSize", label: "Name Size", type: "slider", min: 10, max: 32, step: 1, default: 22, unit: "px" },
                { id: "nameColor", label: "Name Color", type: "color", default: "#7a0c0c" },
                {
                  id: "offscreenStyle",
                  label: "Off-screen Indicator",
                  type: "select",
                  default: "tracers",
                  options: [
                    { value: "none", label: "None" },
                    { value: "tracers", label: "Tracers" },
                    { value: "arrows", label: "Arrows" },
                  ],
                },
                {
                  id: "offscreenTheme",
                  label: "Off-screen Theme",
                  type: "select",
                  default: "classic",
                  options: [
                    { value: "classic", label: "Classic" },
                    { value: "dashed", label: "Dashed" },
                    { value: "neon", label: "Neon" },
                  ],
                },
                { id: "alwaysTracer", label: "Always Show Tracer", type: "checkbox", default: false },
                { id: "tracerWidth", label: "Tracer Width", type: "slider", min: 1, max: 8, step: 1, default: 3, unit: "px" },
                { id: "tracerColor", label: "Tracer Color", type: "color", default: "#ff3b3b" },
                { id: "arrowSize", label: "Arrow Size", type: "slider", min: 8, max: 30, step: 1, default: 14, unit: "px" },
                { id: "arrowColor", label: "Arrow Color", type: "color", default: "#ff3b3b" },
                {
                  id: "arrowStyle",
                  label: "Arrow Style",
                  type: "select",
                  default: "regular",
                  options: [
                    { value: "regular", label: "Regular Arrow" },
                    { value: "dot", label: "Dot" },
                    { value: "modern", label: "Modern Arrow" },
                  ],
                },
              ],
            },
            {
              name: CAMERA_ZOOM_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[CAMERA_ZOOM_MODULE_NAME],
              settings: [
                { id: "zoom", label: "Zoom", type: "slider", min: CAMERA_ZOOM_MIN, max: CAMERA_ZOOM_MAX, step: CAMERA_ZOOM_STEP, default: CAMERA_ZOOM_DEFAULT, unit: "x" },
              ],
            },
          ],
        },
        {
          name: "Qol",
          modules: [
            {
              name: ANIMATION_SKIP_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[ANIMATION_SKIP_MODULE_NAME],
              settings: [],
            },
            {
              name: KEYSTROKES_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[KEYSTROKES_MODULE_NAME],
              settings: [
                { id: "scale", label: "Overlay Scale", type: "slider", min: 50, max: 200, step: 5, default: 100, unit: "%" },
                { id: "opacity", label: "Opacity", type: "slider", min: 20, max: 100, step: 1, default: 92, unit: "%" },
                { id: "showCps", label: "Show CPS", type: "checkbox", default: true },
                { id: "useGlobalAppearance", label: "Use global appearance", type: "checkbox", default: true },
              ],
            },
            {
              name: HIDE_POPUPS_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[HIDE_POPUPS_MODULE_NAME],
              settings: [
                { id: "hideEnergyPopups", label: "Hide Energy Popup", type: "checkbox", default: true },
                { id: "hideBuildingPopups", label: "Hide Building Popup", type: "checkbox", default: true },
              ],
            },
            {
              name: STYLES_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[STYLES_MODULE_NAME],
              settings: [
                { id: "topBarBackground", label: "Top Bar Color", type: "color", default: QUESTION_STYLES_DEFAULTS.topBarBackground },
                { id: "pageBackground", label: "Page Background", type: "color", default: QUESTION_STYLES_DEFAULTS.pageBackground },
                { id: "continueButtonBackground", label: "Continue Button", type: "color", default: QUESTION_STYLES_DEFAULTS.continueButtonBackground },
                { id: "shopButtonBackground", label: "Shop Button", type: "color", default: QUESTION_STYLES_DEFAULTS.shopButtonBackground },
                { id: "questionBackground", label: "Question Background", type: "color", default: QUESTION_STYLES_DEFAULTS.questionBackground },
                { id: "questionText", label: "Question Text", type: "color", default: QUESTION_STYLES_DEFAULTS.questionText },
                { id: "option1Background", label: "Option 1 Background", type: "color", default: QUESTION_STYLES_DEFAULTS.option1Background },
                { id: "option1Text", label: "Option 1 Text", type: "color", default: QUESTION_STYLES_DEFAULTS.option1Text },
                { id: "option2Background", label: "Option 2 Background", type: "color", default: QUESTION_STYLES_DEFAULTS.option2Background },
                { id: "option2Text", label: "Option 2 Text", type: "color", default: QUESTION_STYLES_DEFAULTS.option2Text },
                { id: "option3Background", label: "Option 3 Background", type: "color", default: QUESTION_STYLES_DEFAULTS.option3Background },
                { id: "option3Text", label: "Option 3 Text", type: "color", default: QUESTION_STYLES_DEFAULTS.option3Text },
                { id: "option4Background", label: "Option 4 Background", type: "color", default: QUESTION_STYLES_DEFAULTS.option4Background },
                { id: "option4Text", label: "Option 4 Text", type: "color", default: QUESTION_STYLES_DEFAULTS.option4Text },
                { id: "questionFontSize", label: "Question Font Size", type: "slider", min: 12, max: 64, step: 1, default: QUESTION_STYLES_DEFAULTS.questionFontSize, unit: "px" },
                { id: "answerFontSize", label: "Answer Font Size", type: "slider", min: 10, max: 48, step: 1, default: QUESTION_STYLES_DEFAULTS.answerFontSize, unit: "px" },
                { id: "borderRadius", label: "Border Radius", type: "slider", min: 0, max: 36, step: 1, default: QUESTION_STYLES_DEFAULTS.borderRadius, unit: "px" },
              ],
            },
          ],
        },
        {
          name: "Combat",
          modules: [
            {
              name: "Crosshair",
              description: MODULE_DESCRIPTIONS["Crosshair"],
              settings: [
                { id: "enabled",       label: "Show Crosshair",  type: "checkbox", default: true },
                { id: "style",         label: "Style",            type: "select",   default: "x",
                  options: [
                    { value: "cross",       label: "Cross (gap)" },
                    { value: "solid",       label: "Solid Cross" },
                    { value: "crossdot",    label: "Cross + Dot" },
                    { value: "dot",         label: "Dot" },
                    { value: "circle",      label: "Circle" },
                    { value: "circlecross", label: "Circle + Cross" },
                    { value: "plus",        label: "Plus (thick)" },
                    { value: "x",           label: "X (diagonal)" },
                  ],
                },
                { id: "color",         label: "Crosshair Color",  type: "color",    default: "#ff3b3b" },
                { id: "crosshairSize", label: "Crosshair Size",   type: "slider",   default: 25, min: 4, max: 40, step: 1, unit: "px" },
                { id: "lineSize",      label: "Cursor Width",      type: "slider",   default: 4,  min: 1, max: 6,  step: 0.5, unit: "px" },
                { id: "showLine",       label: "Show Line",         type: "checkbox", default: false },
                { id: "lineColor",      label: "Line Color",        type: "color",    default: "#ff3b3b" },
                { id: "tracerLineSize", label: "Tracer Thickness",  type: "slider",   default: 1.5, min: 0.5, max: 5, step: 0.5, unit: "px" },
                { id: "hoverHighlight", label: "Player Hover",      type: "checkbox", default: true },
                { id: "hoverColor",     label: "Hover Color",       type: "color",    default: "#ffff00" },
                { id: "showCrosshairGlyph", label: "Show Actual Crosshair", type: "checkbox", default: true },
              ],
            },
            {
              name: "Triggerbot (Autoshoot)",
              description: MODULE_DESCRIPTIONS["Triggerbot (Autoshoot)"],
              settings: [
                { id: "enabled",             label: "Enabled",                  type: "checkbox", default: true },
                { id: "teamCheck",           label: "Ignore Teammates",         type: "checkbox", default: true },
                { id: "fovPx",               label: "FOV Radius",               type: "slider",   default: 220, min: 8, max: 220, step: 1, unit: "px" },
                { id: "holdToFire",          label: "Hold Fire While Targeted", type: "checkbox", default: false },
                { id: "fireRateMs",          label: "Fire Rate Limit",          type: "slider",   default: 16, min: 16, max: 500, step: 1, unit: "ms" },
                { id: "requireLOS",          label: "Require LOS (future)",     type: "checkbox", default: false },
                { id: "onlyWhenGameFocused", label: "Only When Focused",        type: "checkbox", default: true },
                { id: "showTargetRing",      label: "Show Target Ring",         type: "checkbox", default: true },
              ],
            },
            {
              name: "Quick Fire",
              description: MODULE_DESCRIPTIONS["Quick Fire"],
              settings: [
                { id: "enabled",             label: "Enabled",              type: "checkbox", default: true },
                { id: "fireIntervalMs",      label: "Fire Interval",        type: "slider",   default: 5, min: 0, max: 250, step: 0.1, unit: "ms" },
                { id: "alwaysFire",          label: "Always fire",          type: "checkbox", default: false },
                { id: "onlyWhenGameFocused", label: "Only When Focused",     type: "checkbox", default: true },
              ],
            },
            {
              name: "Aimbot",
              description: MODULE_DESCRIPTIONS["Aimbot"],
              settings: [
                { id: "enabled",             label: "Enabled",               type: "checkbox", default: true },
                { id: "teamCheck",           label: "Ignore Teammates",      type: "checkbox", default: true },
                { id: "fovDeg",              label: "Aim FOV",               type: "slider",   default: 180, min: 15, max: 180, step: 1, unit: "°" },
                { id: "smoothing",           label: "Smoothing",             type: "slider",   default: 0, min: 0, max: 1, step: 0.01 },
                { id: "maxStepPx",           label: "Max Step",              type: "slider",   default: 120, min: 2, max: 120, step: 1, unit: "px" },
                { id: "minStepPx",           label: "Min Step",              type: "slider",   default: 0, min: 0, max: 8, step: 0.05, unit: "px" },
                { id: "deadzonePx",          label: "Deadzone",              type: "slider",   default: 0, min: 0, max: 12, step: 0.1, unit: "px" },
                { id: "predictionMs",        label: "Prediction",            type: "slider",   default: 0, min: 0, max: 220, step: 1, unit: "ms" },
                { id: "lockMs",              label: "Target Lock",           type: "slider",   default: 0, min: 0, max: 800, step: 5, unit: "ms" },
                { id: "stickToTarget",       label: "Stick To Target",       type: "checkbox", default: false },
                { id: "onlyWhenGameFocused", label: "Only When Focused",     type: "checkbox", default: true },
                { id: "requireMouseDown",    label: "Require Left Mouse",    type: "checkbox", default: false },
                { id: "showDebugDot",        label: "Show Debug Dot",        type: "checkbox", default: true },
              ],
            },
          ],
        },
      ],
    },
    gamemodeSpecific: {
      title: "Gamemode Specific",
      groups: [
        {
          name: "Classic/Tycoon",
          modules: [
            {
              name: "Upgrade HUD",
              description: MODULE_DESCRIPTIONS["Upgrade HUD"],
              settings: [
                {
                  id: "displayTitle",
                  label: "Display Title",
                  type: "checkbox",
                  default: true,
                },
                {
                  id: "showLvlPrefix",
                  label: "Show Lvl Prefix",
                  type: "checkbox",
                  default: false,
                },
                {
                  id: "showUpgradeButton",
                  label: "Show Upgrade Button",
                  type: "checkbox",
                  default: true,
                },
                {
                  id: "hudSize",
                  label: "HUD Size",
                  type: "slider",
                  min: 60,
                  max: 180,
                  step: 5,
                  default: 100,
                  unit: "%",
                },
              ],
            },
            {
              name: "Auto Upgrade",
              description: MODULE_DESCRIPTIONS["Auto Upgrade"],
              settings: [
                { id: "multiplier", label: "Multiplier", type: "checkbox", default: true },
                { id: "moneyPerQuestion", label: "Money / Question", type: "checkbox", default: true },
                { id: "streakBonus", label: "Streak Bonus", type: "checkbox", default: true },
                { id: "insurance", label: "Insurance", type: "checkbox", default: false },
              ],
            },
            {
              name: ABILITY_HUD_MODULE_NAME,
              description: MODULE_DESCRIPTIONS[ABILITY_HUD_MODULE_NAME],
              settings: [
                { id: "abilityHudDisplayMode", label: "Display Mode", type: "select", default: "icons", options: [{ value: "icons", label: "Icons" }, { value: "list", label: "List" }] },
                { id: "abilityHudScale", label: "Scale", type: "slider", min: 0.75, max: 1.25, step: 0.05, default: 0.9 },
                { id: "abilityHudGap", label: "Icon Gap", type: "slider", min: 1, max: 15, step: 1, default: 5, unit: "px" },
                { id: "abilityHudShowPrices", label: "Show Prices", type: "checkbox", default: true },
              ],
            },
          ],
        },
        {
          name: "Floor is Lava",
          modules: [
            {
              name: "Building HUD",
              description: MODULE_DESCRIPTIONS["Building HUD"],
              settings: [
                { id: "displayTitle", label: "Display Title", type: "checkbox", default: true },
                { id: "hudSize", label: "HUD Size", type: "slider", min: 60, max: 180, step: 5, default: 100, unit: "%" },
              ],
            },
          ],
        },
        {
          name: "Draw It",
          modules: [
            {
              name: "Answer Reveal",
              description: MODULE_DESCRIPTIONS["Answer Reveal"],
              settings: [
                {
                  id: "selectorMode",
                  label: "Selector Mode",
                  type: "select",
                  default: "auto",
                  options: [
                    { value: "auto", label: "Auto" },
                    { value: "strict", label: "Strict" },
                  ],
                },
              ],
            },
            {
              name: "Answer Popup",
              description: MODULE_DESCRIPTIONS["Answer Popup"],
              settings: [
                {
                  id: "preset",
                  label: "Preset",
                  type: "select",
                  default: "default",
                  options: [
                    { value: "default", label: "Default (Red)" },
                    { value: "green", label: "Green" },
                    { value: "ice", label: "Ice" },
                    { value: "midnight", label: "Midnight" },
                    { value: "grayscale", label: "Grayscale" },
                  ],
                },
                { id: "text", label: "Popup Text", type: "text", default: "answer" },
                { id: "durationMs", label: "Display Duration", type: "slider", min: 600, max: 8000, step: 100, default: 2600, unit: "ms" },
                { id: "accent", label: "Accent Color", type: "color", default: "#ff4a4a" },
                { id: "textColor", label: "Text Color", type: "color", default: "#ffffff" },
              ],
            },
          ],
        },
      ],
    },
  };

  const state = {
    visible: true,
    searchQuery: "",
    shellWidth: 1160,
    shellHeight: 640,
    enabledModules: new Set(),
    moduleItems: new Map(),
    modulePanels: new Map(),
    moduleEntries: [],
    moduleConfig: new Map(),
    collapsedPanels: {},
    hiddenCategories: {},
    listeningForBind: null,
    listeningForMenuBind: false,
    searchAutofocus: true,
    displayMode: "loose",
    looseInitialized: false,
    loosePositions: {
      topbar: { x: 12, y: 12 },
    },
    loosePanelPositions: {},
    mergedRootPosition: { left: 20, top: 28 },
    globalPreset: "default",
    modules: new Map(),
  };

  // Bumped to v3 — includes display-mode and loose layout position persistence
  const STORAGE_KEY = "anrrgm_client_settings_v3";
  const DEFAULT_FOOTER_HTML = () => `<span>Press <b>${CONFIG.toggleKey}</b> to show/hide menu</span><span>Right click modules for settings</span>`;

  function debounce(fn, waitMs = 120) {
    let timerId = null;
    return (...args) => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        timerId = null;
        fn(...args);
      }, waitMs);
    };
  }

  // Defer all DOM work — WebSocket is already patched above at document-start.

  const WELCOME_POPUP_STORAGE_KEY = "anrrgmWelcomePopupSeenV1";

  function showFirstLaunchWelcomePopup() {
    try {
      if (localStorage.getItem(WELCOME_POPUP_STORAGE_KEY) === "1") return;
    } catch (_) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,.52)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "z-index:2147483647",
      "padding:18px",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif",
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
      "width:min(560px,100%)",
      "border-radius:14px",
      "border:1px solid rgba(255,255,255,.16)",
      "background:linear-gradient(165deg,rgba(31,31,36,.98),rgba(10,10,14,.98))",
      "box-shadow:0 20px 55px rgba(0,0,0,.5)",
      "padding:18px 20px",
      "color:#fff",
      "line-height:1.45",
    ].join(";");

    card.innerHTML = `
      <div style="margin:-18px -20px 14px -20px;padding:10px 14px;border-radius:14px 14px 0 0;border-bottom:1px solid rgba(255,255,255,.18);background:linear-gradient(125deg, rgba(255, 74, 74, 0.24), rgba(56, 16, 16, 0.9));display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;">AnRRgm Client</div>
          <div style="font-size:12px;font-weight:700;opacity:.92;">v${CONFIG.version}</div>
        </div>
        <button type="button" class="anrrgm-welcome-action" id="anrrgm-welcome-x" aria-label="Close" style="appearance:none;width:24px;height:24px;border-radius:7px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.08);color:#fff;font-size:14px;font-weight:800;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,border-color .15s ease,transform .15s ease;">×</button>
      </div>
      <div style="font-size:24px;font-weight:800;margin-bottom:10px;"><b>AnRRgm Client</b></div>
      <div style="font-size:15px;opacity:.92;margin-bottom:14px;">Welcome to <b>AnRRgm Client</b>: a modern hacked client / utility mod for gimkit.<br><br><b>Left-click</b> to enable/disable a module.<br><b>Right-click</b> to configure a modules settings.<br><b>'\\'</b> to hide/show the client.</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <a class="anrrgm-welcome-action" href="https://github.com/AidenRTRRgfdm/AnRRgm-Client" target="_blank" rel="noopener noreferrer" style="text-decoration:none;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.08);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:6px;transition:background .15s ease,border-color .15s ease,transform .15s ease;">
          <img src="https://github.githubassets.com/assets/pinned-octocat-093da3e6fa40.svg" alt="GitHub" style="width:14px;height:14px;display:block;">
          <span>github</span>
        </a>
        
        <button type="button" class="anrrgm-welcome-action" id="anrrgm-welcome-close" style="margin-left:auto;appearance:none;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.08);color:#fff;font-size:12px;font-weight:700;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease;">close</button>
      </div>
    `;

    const close = () => {
      try {
        localStorage.setItem(WELCOME_POPUP_STORAGE_KEY, "1");
      } catch (_) {}
      overlay.remove();
    };

    card.querySelector("#anrrgm-welcome-close")?.addEventListener("click", close);
    card.querySelector("#anrrgm-welcome-x")?.addEventListener("click", close);

    for (const action of card.querySelectorAll(".anrrgm-welcome-action")) {
      action.addEventListener("mouseenter", () => {
        action.style.background = "rgba(255,255,255,.18)";
        action.style.borderColor = "rgba(255,255,255,.42)";
        action.style.transform = "translateY(-1px)";
      });
      action.addEventListener("mouseleave", () => {
        action.style.background = "rgba(255,255,255,.08)";
        action.style.borderColor = "rgba(255,255,255,.24)";
        action.style.transform = "translateY(0)";
      });
    }
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);
  }

  function initUi() {
  // AnRRgm platformer movement. Insert this block at the start of initUi().
  // Current Gimkit physics: Rapier kinematic controller, 100 pixels per unit,
  // 12 physics ticks per second. The controller remains responsible for walls.
  const anrrgmMovementNames = ["Fly", "Noclip", "Speed", "High Jump", "Air Jump", "Short TP"];
  const anrrgmMovement = {
    enabled: new Set(),
    timer: null,
    binding: null,
    focused: document.hasFocus(),
    facing: 1,
    jumpScales: new WeakMap(),
    lastTeleportAt: -Infinity,
    lastMessage: "Movement modules are off.",
    lastToast: "",
    toast: null,
    toastTimer: null,
    mode: "waiting",
    worldScale: 100,
    tickRate: 12,
    disposed: false,
    teleportKeyHeld: false,
    lastInput: null,
    lastMovement: null,
    lastCorrectionAt: -Infinity,
    lastCorrectionToastAt: -Infinity,
    lastCorrection: null,
    lastTeleport: null,
    counters: { input: 0, compute: 0, airJump: 0, highJump: 0, teleport: 0, corrections: 0 },
  };

  function anrrgmMovementConfig(name) {
    try { return moduleCfg(name) || {}; } catch (_) { return {}; }
  }

  function anrrgmMovementNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function anrrgmMovementFlying() {
    return anrrgmMovement.enabled.has("Fly") || anrrgmMovement.enabled.has("Noclip");
  }

  function anrrgmMovementTyping(target) {
    const element = target instanceof Element ? target : null;
    return Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
  }

  function anrrgmMovementBlocked() {
    if (!anrrgmMovement.focused || !document.hasFocus() || document.visibilityState !== "visible") return true;
    if (anrrgmMovementTyping(document.activeElement)) return true;
    if (state.visible || state.listeningForBind || state.listeningForMenuBind) return true;
    if (document.querySelector('.zyrox-config-backdrop:not(.hidden), .anrrgm-config-backdrop:not(.hidden), .zyrox-settings:not(.hidden), .anrrgm-settings:not(.hidden), #zyrox-welcome-overlay, #anrrgm-welcome-overlay')) return true;
    const binding = anrrgmMovement.binding;
    return !binding || binding.input.isListeningForInput === false || binding.stores.me?.isRespawning === true || Boolean(binding.stores.gui?.openInputBlockingUI?.length || binding.stores.gui?.openInputBlockingUI?.size);
  }

  function anrrgmMovementStatus(message, show = false) {
    if (anrrgmMovement.enabled.size && performance.now() - anrrgmMovement.lastCorrectionAt < 6000 && !message.startsWith("Server corrected") && (message.startsWith("Movement ready") || message.startsWith("Movement paused"))) return;
    anrrgmMovement.lastMessage = message;
    if (!show || message === anrrgmMovement.lastToast) return;
    anrrgmMovement.lastToast = message;
    if (!anrrgmMovement.toast?.isConnected) {
      const toast = document.createElement("div");
      toast.id = "anrrgm-movement-status";
      toast.style.cssText = "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483647;padding:8px 13px;border:1px solid rgba(255,90,90,.7);border-radius:9px;background:rgba(12,15,22,.94);color:#fff;font:600 12px system-ui,sans-serif;pointer-events:none;max-width:min(90vw,480px);text-align:center;";
      document.body.appendChild(toast);
      anrrgmMovement.toast = toast;
    }
    anrrgmMovement.toast.textContent = `AnRRgm Client • ${message}`;
    anrrgmMovement.toast.style.display = "block";
    if (anrrgmMovement.toastTimer) clearTimeout(anrrgmMovement.toastTimer);
    anrrgmMovement.toastTimer = setTimeout(() => {
      if (anrrgmMovement.toast) anrrgmMovement.toast.style.display = "none";
      anrrgmMovement.toastTimer = null;
    }, 3200);
  }

  function anrrgmMovementRestoreJump() {
    const forces = anrrgmMovement.binding?.physics?.state?.forces;
    if (!Array.isArray(forces)) return;
    for (const force of forces) {
      const saved = anrrgmMovement.jumpScales.get(force?.ticks);
      if (!saved || !Array.isArray(force.ticks)) continue;
      for (const tick of force.ticks) {
        if (saved.originals.has(tick)) tick.y = saved.originals.get(tick);
      }
      anrrgmMovement.jumpScales.delete(force.ticks);
    }
  }

  function anrrgmMovementClearFlight() {
    const physicsState = anrrgmMovement.binding?.physics?.state;
    if (!physicsState) return;
    if (physicsState.velocity) physicsState.velocity.y = 0;
    if (physicsState.inertia) physicsState.inertia.y = 0;
    if (physicsState.jump) physicsState.jump.isJumping = false;
  }

  function anrrgmMovementDetach() {
    const binding = anrrgmMovement.binding;
    if (!binding) return;
    anrrgmMovementRestoreJump();
    if (anrrgmMovementFlying()) anrrgmMovementClearFlight();
    if (binding.input.getPhysicsInput === binding.inputWrapper) binding.input.getPhysicsInput = binding.originalInput;
    if (binding.controller.computeColliderMovement === binding.computeWrapper) binding.controller.computeColliderMovement = binding.originalCompute;
    if (binding.positionWrapper && binding.physics.setServerPosition === binding.positionWrapper) binding.physics.setServerPosition = binding.originalPosition;
    anrrgmMovement.binding = null;
  }

  function anrrgmMovementResolve() {
    const stores = espState.stores ?? window.stores;
    const scene = stores?.phaser?.scene;
    const character = stores?.phaser?.mainCharacter;
    if (!stores || !scene || !character) {
      anrrgmMovement.mode = "waiting";
      return { message: "Waiting for a platformer game…" };
    }
    if (stores.session?.mapStyle !== "platformer") {
      anrrgmMovement.mode = "unsupported";
      return { message: "Movement requires Don't Look Down or another platformer." };
    }
    let mode = "platformer";
    try {
      const options = JSON.parse(stores.world?.mapOptionsJSON || "{}");
      if (/\/dontlookdown\//i.test(String(options.musicUrl || ""))) mode = "dontlookdown";
    } catch (_) {}
    anrrgmMovement.mode = mode;
    const physics = character.physics;
    let body;
    try { body = physics?.getBody?.(); } catch (_) {}
    const controller = body?.character?.controller;
    const input = scene.inputManager;
    if (character.isMain === false || (stores.network?.authId && character.id !== stores.network.authId)) return { message: "Waiting for your active character…" };
    if (!physics?.state || !body?.rigidBody || !body?.collider || typeof controller?.computeColliderMovement !== "function" || typeof input?.getPhysicsInput !== "function") return { message: "Waiting for compatible platformer physics…" };
    return { stores, scene, character, physics, body, controller, input };
  }

  function anrrgmMovementAcquire(show = false) {
    if (!anrrgmMovement.enabled.size || anrrgmMovement.disposed) return;
    if (anrrgmMovement.lastTeleport?.status === "applied locally" && performance.now() - anrrgmMovement.lastTeleport.at >= 1500) anrrgmMovement.lastTeleport.status = "no correction observed";
    const found = anrrgmMovementResolve();
    if (found.message) {
      anrrgmMovementDetach();
      anrrgmMovementStatus(found.message, show);
      return;
    }
    const previous = anrrgmMovement.binding;
    if (previous && previous.physics === found.physics && previous.controller === found.controller && previous.input === found.input && previous.input.getPhysicsInput === previous.inputWrapper && previous.controller.computeColliderMovement === previous.computeWrapper && (!previous.positionWrapper || previous.physics.setServerPosition === previous.positionWrapper)) {
      anrrgmMovementStatus(anrrgmMovementBlocked() ? "Movement paused while the menu or another input screen is open." : "Movement ready.", show);
      return;
    }
    anrrgmMovementDetach();
    const binding = { ...found, originalInput: found.input.getPhysicsInput, originalCompute: found.controller.computeColliderMovement, originalPosition: found.physics.setServerPosition, nativeComputeArguments: null };
    anrrgmMovement.binding = binding;

    binding.inputWrapper = function (...args) {
      const input = binding.originalInput.apply(this, args);
      anrrgmMovement.counters.input += 1;
      anrrgmMovement.lastInput = input ? { ...input } : null;
      if (anrrgmMovement.binding !== binding || anrrgmMovementBlocked()) return input;
      const physicsState = binding.physics.state;
      if (input?.isHoldingLeft && !input?.isHoldingRight) anrrgmMovement.facing = -1;
      if (input?.isHoldingRight && !input?.isHoldingLeft) anrrgmMovement.facing = 1;
      if (anrrgmMovementFlying()) {
        anrrgmMovementClearFlight();
        physicsState.forces = physicsState.forces.filter(force => force.id !== "jump");
        if (physicsState.wallJump) {
          physicsState.wallJump.ticks = -1;
          physicsState.wallJump.transitionTicks = -1;
          physicsState.wallJump.forceInputTicks = 0;
        }
        return { ...input, jump: false };
      }
      if (anrrgmMovement.enabled.has("Air Jump") && input?.jump && !physicsState.grounded && physicsState.jump && Number(physicsState.jump.jumpTicks) >= 2 && !(physicsState.jump.jumpsLeft > 0)) {
        physicsState.jump.jumpsLeft = 1;
        anrrgmMovement.counters.airJump += 1;
      }
      return input;
    };

    binding.computeWrapper = function (collider, requested, ...args) {
      // Save the game's collision flags/filter for the bounded teleport action.
      // A zero-argument zero-movement call is a native teleport/reset query.
      // It must remain untouched and must not replace the movement filter.
      if (!args.length) return binding.originalCompute.call(this, collider, requested, ...args);
      if (collider === binding.body.collider) binding.nativeComputeArguments = args;
      if (collider !== binding.body.collider || anrrgmMovement.binding !== binding || anrrgmMovementBlocked() || !requested || !Number.isFinite(requested.x) || !Number.isFinite(requested.y)) return binding.originalCompute.call(this, collider, requested, ...args);
      const physicsState = binding.physics.state;
      const movement = { x: requested.x, y: requested.y };
      if (anrrgmMovement.enabled.has("High Jump") && !anrrgmMovementFlying()) {
        const force = physicsState.forces?.find(item => item.id === "jump" && Array.isArray(item.ticks));
        if (force && !anrrgmMovement.jumpScales.has(force.ticks)) {
          const multiplier = anrrgmMovementNumber(anrrgmMovementConfig("High Jump").heightMultiplier, 1.8, 1, 4);
          // Gimkit's jump cache returns a shallow array copy. Clone vectors too,
          // so repeated jumps never multiply cached native jump trajectories.
          force.ticks = force.ticks.map(tick => ({ ...tick }));
          const originals = new Map();
          for (const tick of force.ticks) {
            originals.set(tick, tick.y);
            tick.y *= multiplier;
          }
          anrrgmMovement.jumpScales.set(force.ticks, { originals, multiplier });
          anrrgmMovement.counters.highJump += 1;
          // The solver already consumed the first jump tick before this call.
          // Its jump contribution is additional to the state's vertical velocity.
          const velocityY = Number(physicsState.velocity?.y) || 0;
          const jumpY = movement.y - velocityY;
          if (jumpY < 0) movement.y = velocityY + jumpY * multiplier;
        }
      }
      if (anrrgmMovementFlying()) {
        const keyboard = binding.input.keyboard?.state || {};
        const held = binding.input.keyboard?.heldKeys;
        const mobile = binding.stores.me?.mobileControls || {};
        const up = Boolean(keyboard.isHoldingUp || keyboard.isHoldingSpace || mobile.up);
        const down = Boolean(keyboard.isHoldingDown || mobile.down || held?.has?.(16));
        const right = Boolean(keyboard.isHoldingRight || mobile.right);
        const left = Boolean(keyboard.isHoldingLeft || mobile.left);
        const freeFlightModule = anrrgmMovement.enabled.has("Noclip") ? "Noclip" : "Fly";
        const speed = anrrgmMovementNumber(anrrgmMovementConfig(freeFlightModule).flySpeed, freeFlightModule === "Noclip" ? 60 : 310, 20, 700);
        const distance = speed / anrrgmMovement.worldScale / anrrgmMovement.tickRate;
        movement.x = (Number(right) - Number(left)) * distance;
        movement.y = (Number(down) - Number(up)) * distance;
        anrrgmMovementClearFlight();
        // Native kinematic translation rejects motion that opposes its original
        // gravity vector unless the character is jumping. Flight needs this flag.
        if (physicsState.jump) physicsState.jump.isJumping = true;
      }
      if (anrrgmMovement.enabled.has("Speed")) movement.x *= anrrgmMovementNumber(anrrgmMovementConfig("Speed").speedMultiplier, 1.6, 1, 4);
      physicsState.lastUsedVelocityToCalculateMovement = { ...movement };
      let snapDistance;
      let snapEnabled = false;
      if (anrrgmMovementFlying()) {
        snapEnabled = this.snapToGroundEnabled?.() === true;
        snapDistance = this.snapToGroundDistance?.();
        if (snapEnabled) this.disableSnapToGround?.();
      }
      const computeArgs = [...args];
      if (anrrgmMovement.enabled.has("Noclip")) computeArgs[2] = () => false;
      try {
        const result = binding.originalCompute.call(this, collider, movement, ...computeArgs);
        const actual = this.computedMovement?.();
        anrrgmMovement.counters.compute += 1;
        anrrgmMovement.lastMovement = {
          upstream: { x: requested.x, y: requested.y }, requested: { ...movement },
          actual: actual ? { x: actual.x, y: actual.y } : null,
        };
        return result;
      }
      finally { if (snapEnabled && Number.isFinite(snapDistance)) this.enableSnapToGround?.(snapDistance); }
    };
    binding.input.getPhysicsInput = binding.inputWrapper;
    binding.controller.computeColliderMovement = binding.computeWrapper;
    if (typeof binding.originalPosition === "function") {
      binding.positionWrapper = function (update, ...args) {
        const packet = Number(update?.packet);
        const serverUpdate = update?.packet != null && Number.isFinite(packet) && packet <= Number(binding.physics.currentPacketId) && update?.teleport !== true;
        let before;
        if (serverUpdate) {
          try { before = { ...binding.body.rigidBody.translation() }; } catch (_) {}
        }
        // Apply the authoritative state and let Gimkit replay outstanding input.
        // Comparing the pre-replay packet coordinates would count normal latency.
        const result = binding.originalPosition.call(this, update, ...args);
        if (serverUpdate && before && anrrgmMovement.binding === binding) {
          let after;
          try { after = { ...binding.body.rigidBody.translation() }; } catch (_) {}
          if (after) {
            const distancePx = Math.hypot(after.x - before.x, after.y - before.y) * anrrgmMovement.worldScale;
            if (Number.isFinite(distancePx) && distancePx > 10) {
              const now = performance.now();
              anrrgmMovement.counters.corrections += 1;
              anrrgmMovement.lastCorrectionAt = now;
              anrrgmMovement.lastCorrection = { at: now, distancePx, packet, before, after };
              const teleport = anrrgmMovement.lastTeleport;
              if (teleport && now - teleport.at <= 1500) {
                const dx = teleport.target.x - teleport.origin.x;
                const dy = teleport.target.y - teleport.origin.y;
                const length = Math.hypot(dx, dy);
                const reversedPx = length > 0 ? -((after.x - before.x) * dx + (after.y - before.y) * dy) / length * anrrgmMovement.worldScale : 0;
                if (reversedPx > 10) teleport.status = "server corrected";
              }
              const toast = now - anrrgmMovement.lastCorrectionToastAt >= 4000;
              if (toast) {
                anrrgmMovement.lastCorrectionToastAt = now;
                anrrgmMovement.lastToast = "";
              }
              anrrgmMovementStatus(`Server corrected movement (${Math.round(distancePx)} px).`, toast);
            }
          }
        }
        return result;
      };
      binding.physics.setServerPosition = binding.positionWrapper;
    }
    anrrgmMovementStatus(anrrgmMovementBlocked() ? `Movement ready. Press ${CONFIG.toggleKey} to close the menu.` : "Movement ready.", show);
  }

  function anrrgmMovementTeleport(event) {
    if (!anrrgmMovement.enabled.has("Short TP") || event.repeat || event.code !== "KeyB" || event.ctrlKey || event.metaKey || event.altKey || anrrgmMovementTyping(event.target) || anrrgmMovement.teleportKeyHeld) return;
    anrrgmMovement.teleportKeyHeld = true;
    anrrgmMovementAcquire();
    const binding = anrrgmMovement.binding;
    if (!binding || anrrgmMovementBlocked()) return;
    const cfg = anrrgmMovementConfig("Short TP");
    const cooldown = anrrgmMovementNumber(cfg.cooldownMs, 0, 0, 2500);
    const now = performance.now();
    if (now - anrrgmMovement.lastTeleportAt < cooldown) return;
    if (!binding.nativeComputeArguments) {
      anrrgmMovementStatus("TP is waiting for the first physics step.", true);
      return;
    }
    event.preventDefault();
    const distance = anrrgmMovementNumber(cfg.distance, 25, 5, 150) / anrrgmMovement.worldScale;
    const direction = String(cfg.direction || "facing");
    const delta = direction === "up" ? { x: 0, y: -distance } : direction === "down" ? { x: 0, y: distance } : direction === "left" ? { x: -distance, y: 0 } : direction === "right" ? { x: distance, y: 0 } : { x: distance * anrrgmMovement.facing, y: 0 };
    const position = binding.body.rigidBody.translation();
    binding.body.collider.setTranslation(position);
    const computeArgs = [...binding.nativeComputeArguments];
    if (anrrgmMovement.enabled.has("Noclip")) computeArgs[2] = () => false;
    binding.originalCompute.call(binding.controller, binding.body.collider, delta, ...computeArgs);
    const actual = binding.controller.computedMovement();
    const target = { x: position.x + actual.x, y: position.y + actual.y };
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
    const physicsState = binding.physics.state;
    const reset = {
      velocity: { x: 0, y: 0 }, inertia: { x: 0, y: 0 }, forces: [], actualMovement: { x: 0, y: 0 },
      movement: { ...physicsState.movement, direction: "none", xVelocity: 0, accelerationTicks: 0 },
      jump: { ...physicsState.jump, isJumping: false }, grounded: false, groundedTicks: 0,
      wallJump: { ...physicsState.wallJump, ticks: -1, transitionTicks: -1, forceInputTicks: 0, slidingSide: undefined, slidingTicks: 0, jumpBuffer: [] },
    };
    if (typeof binding.physics.setServerPosition === "function") {
      binding.physics.setServerPosition({ x: target.x * anrrgmMovement.worldScale, y: target.y * anrrgmMovement.worldScale, jsonState: reset, teleport: true });
    } else {
      binding.body.rigidBody.setTranslation(target, true);
      binding.body.rigidBody.setNextKinematicTranslation(target);
      binding.body.collider.setTranslation(target);
      Object.assign(physicsState, reset);
      binding.character.movement?.onMainCharacterTeleport?.();
    }
    anrrgmMovement.lastTeleportAt = now;
    anrrgmMovement.counters.teleport += 1;
    anrrgmMovement.lastTeleport = { at: now, origin: { ...position }, target: { ...target }, distancePx: Math.hypot(actual.x, actual.y) * anrrgmMovement.worldScale, status: "applied locally" };
    anrrgmMovementStatus(`Local TP: ${Math.round(anrrgmMovement.lastTeleport.distancePx)} px.`, true);
  }

  function anrrgmMovementTeleportKeyUp(event) {
    if (event.code === "KeyB") anrrgmMovement.teleportKeyHeld = false;
  }

  function anrrgmMovementStart(name) {
    if (anrrgmMovement.disposed) return;
    anrrgmMovement.enabled.add(name);
    anrrgmMovement.focused = document.hasFocus();
    if (!anrrgmMovement.timer) {
      window.addEventListener("keydown", anrrgmMovementTeleport);
      window.addEventListener("keyup", anrrgmMovementTeleportKeyUp);
      anrrgmMovement.timer = setInterval(() => anrrgmMovementAcquire(), 400);
    }
    anrrgmMovement.lastToast = "";
    anrrgmMovementAcquire(true);
  }

  function anrrgmMovementStop(name) {
    if (name === "High Jump") anrrgmMovementRestoreJump();
    if (name === "Fly" || name === "Noclip") anrrgmMovementClearFlight();
    if (name === "Short TP") anrrgmMovement.teleportKeyHeld = false;
    anrrgmMovement.enabled.delete(name);
    if (!anrrgmMovement.enabled.size) {
      anrrgmMovementDetach();
      if (anrrgmMovement.timer) clearInterval(anrrgmMovement.timer);
      anrrgmMovement.timer = null;
      window.removeEventListener("keydown", anrrgmMovementTeleport);
      window.removeEventListener("keyup", anrrgmMovementTeleportKeyUp);
      anrrgmMovementStatus("Movement modules are off.");
      if (anrrgmMovement.toastTimer) clearTimeout(anrrgmMovement.toastTimer);
      anrrgmMovement.toastTimer = null;
      anrrgmMovement.toast?.remove();
      anrrgmMovement.toast = null;
    }
  }

  window.addEventListener("blur", () => {
    anrrgmMovement.focused = false;
    anrrgmMovement.teleportKeyHeld = false;
    if (anrrgmMovementFlying()) anrrgmMovementClearFlight();
  });
  window.addEventListener("focus", () => { anrrgmMovement.focused = true; });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      anrrgmMovement.teleportKeyHeld = false;
      if (anrrgmMovementFlying()) anrrgmMovementClearFlight();
    }
  });
  window.addEventListener("pagehide", () => {
    for (const name of [...anrrgmMovement.enabled]) anrrgmMovementStop(name);
    anrrgmMovement.disposed = true;
  }, { once: true });

  for (const name of anrrgmMovementNames) MODULE_BEHAVIORS[name] = {
    onEnable: () => anrrgmMovementStart(name), onDisable: () => anrrgmMovementStop(name),
  };
  Object.assign(MODULE_DESCRIPTIONS, {
    "Fly": "Client-side flight with WASD/arrows. Space rises; Shift descends. The server may correct movement.",
    "Noclip": "Client-side freeflight through walls with WASD/arrows. Space rises; Shift descends. Also lets Short TP pass walls. The server may correct movement.",
    "Speed": "Multiplies client-side horizontal movement. The server may correct movement.",
    "High Jump": "Scales client-side jump height. Jump with W, Up Arrow, or Space; the server may correct movement.",
    "Air Jump": "Allows client-side airborne jumps. Release and press Jump again; the server may correct movement.",
    "Short TP": "Press B for a bounded local blink. Enable Noclip to pass walls. Cooldown can be zero; the server may correct movement.",
  });
  MENU_LAYOUT.gamemodeSpecific.groups.push({ name: "Don't Look Down", modules: [
    { name: "Fly", description: MODULE_DESCRIPTIONS.Fly, settings: [
      { id: "flySpeed", label: "Fly Speed", type: "slider", min: 20, max: 700, step: 10, default: 310, unit: " px/s" },
    ] },
    { name: "Noclip", description: MODULE_DESCRIPTIONS.Noclip, settings: [
      { id: "flySpeed", label: "Noclip Speed", type: "slider", min: 20, max: 700, step: 10, default: 60, unit: " px/s" },
    ] },
    { name: "Speed", description: MODULE_DESCRIPTIONS.Speed, settings: [
      { id: "speedMultiplier", label: "Speed Multiplier", type: "slider", min: 1, max: 4, step: 0.1, default: 1.6, unit: "x" },
    ] },
    { name: "High Jump", description: MODULE_DESCRIPTIONS["High Jump"], settings: [
      { id: "heightMultiplier", label: "Jump Height", type: "slider", min: 1, max: 4, step: 0.1, default: 1.8, unit: "x" },
    ] },
    { name: "Air Jump", description: MODULE_DESCRIPTIONS["Air Jump"], settings: [] },
    { name: "Short TP", description: MODULE_DESCRIPTIONS["Short TP"], settings: [
      { id: "distance", label: "TP Distance", type: "slider", min: 5, max: 150, step: 5, default: 25, unit: " px" },
      { id: "cooldownMs", label: "Cooldown", type: "slider", min: 0, max: 2500, step: 100, default: 0, unit: "ms" },
      { id: "direction", label: "TP Direction", type: "select", default: "facing", options: [
        { value: "facing", label: "Facing" }, { value: "up", label: "Up" }, { value: "down", label: "Down" },
        { value: "left", label: "Left" }, { value: "right", label: "Right" },
      ] },
    ] },
  ] });
  const anrrgmMovementGetStatus = () => ({
    message: anrrgmMovement.lastMessage, mode: anrrgmMovement.mode,
    enabled: [...anrrgmMovement.enabled], hooked: Boolean(anrrgmMovement.binding),
    paused: anrrgmMovement.binding ? anrrgmMovementBlocked() : true,
    worldScale: anrrgmMovement.worldScale, tickRate: anrrgmMovement.tickRate,
    lastTeleportAt: Number.isFinite(anrrgmMovement.lastTeleportAt) ? anrrgmMovement.lastTeleportAt : null,
    attachedMethods: anrrgmMovement.binding ? ["inputManager.getPhysicsInput", "character.controller.computeColliderMovement", ...(anrrgmMovement.binding.positionWrapper ? ["physics.setServerPosition"] : [])] : [],
    waitingReason: anrrgmMovement.binding ? null : anrrgmMovement.lastMessage,
    input: anrrgmMovement.lastInput ? { ...anrrgmMovement.lastInput } : null,
    movement: anrrgmMovement.lastMovement ? JSON.parse(JSON.stringify(anrrgmMovement.lastMovement)) : null,
    counters: { ...anrrgmMovement.counters },
    lastCorrectionDistancePx: anrrgmMovement.lastCorrection?.distancePx ?? null,
    correction: anrrgmMovement.lastCorrection ? JSON.parse(JSON.stringify(anrrgmMovement.lastCorrection)) : null,
    teleport: anrrgmMovement.lastTeleport ? JSON.parse(JSON.stringify(anrrgmMovement.lastTeleport)) : null,
  });
  window.__anrrgmMovement = Object.freeze({
    get status() { return anrrgmMovementGetStatus(); }, getStatus: anrrgmMovementGetStatus,
  });

    showFirstLaunchWelcomePopup();

  const style = document.createElement("style");
  style.textContent = `
    .anrrgm-root,
    .anrrgm-config-backdrop {
      --arr-border: #ff6f6f99;
      --arr-border-soft: rgba(255, 255, 255, 0.12);
      --arr-text: #d6d6df;
      --arr-text-strong: #fff;
      --arr-header-text: #fff;
      --arr-header-bg-start: rgba(255, 74, 74, 0.24);
      --arr-header-bg-end: rgba(60, 18, 18, 0.92);
      --arr-topbar-bg-start: rgba(255, 74, 74, 0.22);
      --arr-topbar-bg-end: rgba(56, 16, 16, 0.9);
      --arr-icon-color: #ffdada;
      --arr-outline-color: #ff5b5bcc;
      --arr-slider-color: #ff6b6b;
      --arr-panel-count-text: #ffd9d9;
      --arr-panel-count-border: rgba(255, 100, 100, 0.45);
      --arr-panel-count-bg: rgba(8, 8, 10, 0.6);
      --arr-settings-header-start: rgba(255, 61, 61, .3);
      --arr-settings-header-end: rgba(45, 12, 12, .95);
      --arr-settings-sidebar-bg: rgba(24, 24, 32, .22);
      --arr-settings-body-bg: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      --arr-settings-text: #ffe5e5;
      --arr-settings-subtext: #c2c2ce;
      --arr-settings-card-bg: rgba(255,255,255,.03);
      --arr-settings-card-border: rgba(255,255,255,.08);
      --arr-select-bg: rgba(20, 20, 28, 0.9);
      --arr-select-text: #ffe5e5;
      --arr-input-bg: rgba(20, 20, 28, 0.9);
      --arr-input-text: #ffe5e5;
      --arr-accent-soft: #ffbdbd;
      --arr-search-text: #ffe6e6;
      --arr-checkmark-color: #ff6b6b;
      --arr-module-disabled-bg: rgba(0, 0, 0, 0.72);
      --arr-module-hover-bg: rgba(30, 30, 36, 0.9);
      --arr-module-hover-border: rgba(255, 255, 255, 0.14);
      --arr-module-active-start: rgba(255, 61, 61, 0.32);
      --arr-module-active-end: rgba(40, 10, 10, 0.8);
      --arr-module-active-border: rgba(255, 61, 61, 0.52);
      --arr-hover-shift: 2px;
      --arr-shell-blur: 10px;
      --arr-muted: #9b9bab;
      --arr-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
      --arr-radius-xl: 14px;
      --arr-radius-lg: 12px;
      --arr-radius-md: 10px;
      --arr-font: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      /* FIX: button accent colours are now CSS variables, updated by applyAppearance() */
      --arr-btn-bg: rgba(255, 61, 61, 0.12);
      --arr-btn-hover-bg: rgba(255, 61, 61, 0.2);
    }

    .anrrgm-root {
      all: initial;
      position: fixed;
      top: 28px;
      left: 20px;
      z-index: 2147483647;
      color: var(--arr-text);
      user-select: none;
      font-family: var(--arr-font);
    }

    .anrrgm-root * { box-sizing: border-box; font-family: inherit; }

    .anrrgm-config-backdrop {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483648;
      background: rgba(0, 0, 0, 0.26);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--arr-settings-text);
      font-family: var(--arr-font);
    }

    .anrrgm-config-backdrop * { box-sizing: border-box; font-family: inherit; }
    .anrrgm-hidden { display: none !important; }

    .anrrgm-shell {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      width: 1160px;
      height: 640px;
      border-radius: var(--arr-radius-xl);
      border: 1px solid var(--arr-border-soft);
      background: linear-gradient(150deg, #ff3d3d22, rgba(0, 0, 0, 0.45));
      backdrop-filter: blur(var(--arr-shell-blur)) saturate(115%);
      box-shadow: var(--arr-shadow);
      overflow: auto;
    }

    .anrrgm-topbar {
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border-radius: var(--arr-radius-lg);
      border: 1px solid var(--arr-border);
      background: linear-gradient(125deg, var(--arr-topbar-bg-start), var(--arr-topbar-bg-end));
      cursor: move;
    }

    .anrrgm-topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Hide legacy topbar category controls from older builds/state */
    .anrrgm-collapse-row,
    .anrrgm-collapse-btn {
      display: none !important;
    }

    .anrrgm-shell.loose-mode {
      padding: 0;
      width: auto !important;
      height: auto !important;
      min-width: 0;
      min-height: 0;
      border: none;
      box-shadow: none;
      background: transparent !important;
      backdrop-filter: none !important;
      overflow: visible;
    }

    .anrrgm-shell.loose-mode .anrrgm-footer,
    .anrrgm-shell.loose-mode .anrrgm-resize-handle {
      display: none;
    }

    .anrrgm-shell.loose-mode .anrrgm-topbar {
      position: absolute;
      top: 0;
      left: 0;
      width: fit-content;
      min-height: 38px;
      padding: 6px 10px;
      z-index: 4;
    }

    .anrrgm-shell.loose-mode .anrrgm-section {
      display: contents;
    }

    .anrrgm-shell.loose-mode .anrrgm-section-label {
      display: none;
    }

    .anrrgm-shell.loose-mode .anrrgm-panels {
      display: block;
      overflow: visible;
      max-height: none;
      padding: 0;
    }

    .anrrgm-shell.loose-mode .anrrgm-panel {
      position: absolute;
      width: 212px;
      z-index: 3;
    }

    .anrrgm-shell.loose-mode .anrrgm-panel-header {
      cursor: move;
    }


    .anrrgm-brand { display: flex; align-items: center; gap: 10px; color: var(--arr-text-strong); }

    .anrrgm-logo {
      width: 30px;
      height: 30px;
      border-radius: 6px;
      object-fit: contain;
      box-shadow: 0 0 0 1px rgba(255,255,255,.25), 0 0 18px rgba(255,61,61,.45);
      outline: 1px solid var(--arr-icon-color);
    }

    .anrrgm-brand .title { font-size: 13px; font-weight: 700; line-height: 1; }
    .anrrgm-brand .subtitle { font-size: 10px; font-weight: 500; color: rgba(255,255,255,.7); }

    .anrrgm-chip {
      font-size: 10px;
      color: var(--arr-settings-text);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--arr-outline-color);
      border-radius: 999px;
      padding: 4px 8px;
      line-height: 1;
    }

    .anrrgm-keybind-btn {
      font-size: 10px;
      color: var(--arr-icon-color);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--arr-outline-color);
      border-radius: 8px;
      padding: 4px 8px;
      line-height: 1;
      cursor: pointer;
    }

    .anrrgm-settings-btn {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      color: var(--arr-icon-color);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--arr-outline-color);
      border-radius: 8px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }

    .anrrgm-search {
      width: 190px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid var(--arr-outline-color);
      background: rgba(10, 8, 8, 0.72);
      color: var(--arr-search-text);
      padding: 0 10px;
      font-size: 12px;
      outline: none;
    }

    .anrrgm-search:focus {
      background: rgba(15, 12, 12, 0.8);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .anrrgm-section { display: flex; flex-direction: column; gap: 7px; }
    .anrrgm-section-label {
      font-size: 10px;
      letter-spacing: 0.25px;
      color: var(--arr-accent-soft);
      padding-left: 2px;
      text-transform: uppercase;
    }

    .anrrgm-panels {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-start;
      align-content: flex-start;
      overflow: auto;
      max-width: 100%;
      padding-bottom: 2px;
      max-height: 38vh;
    }

    /* FIX: was hardcoded rgba(255, 61, 61, 0.3) — now follows theme */
    .anrrgm-panels::-webkit-scrollbar { width: 8px; height: 8px; }
    .anrrgm-panels::-webkit-scrollbar-thumb { background: var(--arr-btn-hover-bg); border-radius: 999px; }

    .anrrgm-panel {
      width: 212px;
      border-radius: var(--arr-radius-lg);
      border: 1px solid var(--arr-border-soft);
      background: linear-gradient(180deg, rgba(24, 24, 30, 0.9), rgba(10, 10, 12, 0.9));
      overflow: hidden;
    }

    .anrrgm-panel-header {
      min-height: 33px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--arr-header-text);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(90deg, var(--arr-header-bg-start), var(--arr-header-bg-end));
    }

    .anrrgm-panel-collapse-btn {
      font-size: 14px;
      color: var(--arr-panel-count-text);
      background: transparent;
      border: none;
      padding: 0;
      line-height: 1;
      cursor: pointer;
      user-select: none;
    }

    .anrrgm-panel-collapse-btn.collapsed {
      opacity: 0.62;
    }

    .anrrgm-hidden-categories-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }

    .anrrgm-hidden-category-btn {
      border: 1px solid var(--arr-outline-color);
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(0, 0, 0, 0.16));
      color: var(--arr-settings-text);
      padding: 6px 11px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.2px;
      cursor: pointer;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
      transition: background .12s ease, border-color .12s ease, opacity .12s ease, transform .12s ease;
    }

    .anrrgm-hidden-category-btn:hover {
      background: linear-gradient(180deg, var(--arr-btn-hover-bg), rgba(0, 0, 0, 0.22));
      border-color: var(--arr-panel-count-border);
      transform: translateY(-1px);
    }

    .anrrgm-hidden-category-btn.is-hidden {
      opacity: 0.72;
      text-decoration: line-through;
      border-color: rgba(255, 120, 120, 0.44);
      background: linear-gradient(180deg, rgba(255, 80, 80, 0.18), rgba(55, 0, 0, 0.2));
    }

    .anrrgm-module-list { margin: 0; padding: 7px; list-style: none; display: flex; flex-direction: column; gap: 5px; }

    .anrrgm-module {
      min-height: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
      font-size: 13px;
      font-weight: 500;
      color: var(--arr-text);
      border: 1px solid transparent;
      border-radius: var(--arr-radius-md);
      background: var(--arr-module-disabled-bg);
      transition: transform .11s ease, background .11s ease, border-color .11s ease, color .11s ease;
      cursor: pointer;
      white-space: nowrap;
    }

    .anrrgm-module:hover {
      background: var(--arr-module-hover-bg);
      border-color: var(--arr-module-hover-border);
      color: var(--arr-settings-text);
      transform: translateX(var(--arr-hover-shift));
    }

    .anrrgm-module.active {
      color: #fff;
      background: linear-gradient(90deg, var(--arr-module-active-start), var(--arr-module-active-end));
      border-color: var(--arr-module-active-border);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    }

    .anrrgm-bind-label {
      font-size: 10px;
      color: var(--arr-muted);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 2px 5px;
      line-height: 1;
      background: rgba(0, 0, 0, 0.35);
    }

    .anrrgm-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      color: var(--arr-muted);
      font-size: 10px;
      padding: 0 3px;
    }

    .anrrgm-config {
      position: relative;
      z-index: 2147483649;
      width: min(460px, 92vw);
      min-width: 340px;
      border-radius: 11px;
      border: 1px solid var(--arr-border);
      background: linear-gradient(180deg, rgba(18, 18, 22, 0.97), rgba(8, 8, 10, 0.97));
      box-shadow: var(--arr-shadow);
      overflow: hidden;
    }

    .anrrgm-config.hidden { display: none !important; }
    /* FIX: config header now uses settings-header vars so it follows the theme */
    .anrrgm-config-header { padding: 10px 72px 10px 12px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, var(--arr-settings-header-start), var(--arr-settings-header-end)); }
    .anrrgm-config-title { color: var(--arr-settings-text); font-size: 12px; font-weight: 700; margin-bottom: 2px; line-height: 1.2; }
    .anrrgm-config-sub { color: var(--arr-settings-subtext); font-size: 11px; line-height: 1.2; }
    .anrrgm-config-body { padding: 13px; color: var(--arr-settings-text); }
    .anrrgm-config-row { display:flex; justify-content:space-between; align-items:center; gap:8px; color:var(--arr-settings-text); font-size:14px; }
    .anrrgm-hold-toggle { display:inline-flex; align-items:center; gap:6px; margin-left:auto; font-size:12px; color:var(--arr-settings-subtext); cursor:pointer; user-select:none; }
    .anrrgm-hold-toggle input[type='checkbox'] { width:16px; height:16px; margin:0; accent-color:var(--arr-checkmark-color); cursor:pointer; }
    .anrrgm-config-actions { display: flex; align-items: center; gap: 6px; }

    /* FIX: was hardcoded rgba(255, 61, 61, ...) — now reads CSS variables set by applyAppearance() */
    .anrrgm-btn {
      border: 1px solid var(--arr-outline-color);
      background: var(--arr-btn-bg);
      color: var(--arr-settings-text);
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
    }

    .anrrgm-btn:hover { background: var(--arr-btn-hover-bg); color: #fff; }

    .anrrgm-btn-square {
      width: 33px;
      height: 33px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      line-height: 1;
      font-size: 16px;
      color: var(--arr-icon-color);
    }

    .anrrgm-config-backdrop.hidden { display: none !important; }

    .anrrgm-settings {
      position: relative;
      z-index: 2147483649;
      width: min(760px, 92vw);
      height: min(620px, 88vh);
      border-radius: 12px;
      border: 1px solid var(--arr-border);
      background: var(--arr-settings-body-bg);
      box-shadow: var(--arr-shadow);
      overflow: hidden;
      color: var(--arr-settings-text);
      font-family: var(--arr-font);
      display: flex;
      flex-direction: column;
    }

    .anrrgm-config {
      font-family: var(--arr-font);
    }

    .esp-value-text {
      font-family: var(--arr-font);
      font-size: 0.85em;
    }

    .anrrgm-settings.hidden { display: none !important; }
    .anrrgm-settings-header { padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.09); background: linear-gradient(90deg, var(--arr-settings-header-start), var(--arr-settings-header-end)); }
    .anrrgm-settings-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; color: var(--arr-settings-text); }
    .anrrgm-settings-sub { font-size: 12px; color: var(--arr-settings-subtext); }
    .anrrgm-settings-layout { display: grid; grid-template-columns: 150px 1fr; min-height: 0; flex: 1; }
    .anrrgm-settings-sidebar {
      border-right: 1px solid rgba(255,255,255,.08);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--arr-settings-sidebar-bg);
    }
    .anrrgm-settings-tab {
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 7px 8px;
      font-size: 12px;
      color: var(--arr-settings-text);
      background: rgba(0,0,0,.2);
      text-align: left;
      cursor: pointer;
    }
    .anrrgm-settings-tab.active {
      border-color: var(--arr-outline-color);
      background: color-mix(in srgb, var(--arr-topbar-bg-start) 75%, transparent);
      color: #fff;
    }
    .anrrgm-settings-pane { min-height: 0; display: flex; }
    .anrrgm-settings-body { padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow: auto; min-height: 0; width: 100%; }
    .anrrgm-settings-body::-webkit-scrollbar { width: 10px; }
    .anrrgm-settings-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--arr-outline-color) 70%, transparent); border-radius: 999px; }
    .anrrgm-settings-pane.hidden { display: none !important; }
    .anrrgm-setting-card { border: 1px solid var(--arr-settings-card-border); border-radius: 10px; padding: 8px 10px; background: var(--arr-settings-card-bg); display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .anrrgm-setting-card label { display:block; font-size: 12px; color: var(--arr-settings-text); margin: 0; }
    .anrrgm-setting-card input[type="text"],
    .anrrgm-config-body input[type="text"] {
      background: var(--arr-input-bg);
      color: var(--arr-input-text);
      border: 1px solid var(--arr-settings-card-border);
      border-radius: 8px;
      padding: 6px 8px;
      min-width: 150px;
    }
    .anrrgm-setting-card input[type='color'] {
      width: 52px;
      height: 30px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      overflow: hidden;
      padding: 0;
    }
    .anrrgm-setting-card input[type='range'] { width: 190px; accent-color: var(--arr-slider-color); }
    .anrrgm-setting-card input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--arr-checkmark-color); }
    .anrrgm-setting-card select {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      border: 1px solid var(--arr-settings-card-border);
      background: var(--arr-select-bg);
      background-image:
        linear-gradient(45deg, transparent 50%, var(--arr-select-text) 50%),
        linear-gradient(135deg, var(--arr-select-text) 50%, transparent 50%);
      background-position:
        calc(100% - 14px) calc(50% - 2px),
        calc(100% - 8px) calc(50% - 2px);
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
      color: var(--arr-select-text);
      border-radius: 8px;
      padding: 6px 26px 6px 8px;
      font-size: 12px;
      min-height: 30px;
    }
    .anrrgm-setting-card select:focus {
      outline: 1px solid var(--arr-outline-color);
      outline-offset: 1px;
    }
    .anrrgm-setting-card select option {
      background: var(--arr-select-bg);
      color: var(--arr-select-text);
    }
    .anrrgm-gradient-pair { display: inline-flex; align-items: center; gap: 8px; }
    .anrrgm-preset-header { font-size: 10px; text-transform: uppercase; letter-spacing: .35px; color: var(--arr-accent-soft); margin-bottom: 4px; }
    .anrrgm-preset-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
    .anrrgm-preset-btn { border: 1px solid var(--arr-outline-color); background: rgba(0,0,0,.26); color: var(--arr-settings-text); border-radius: 8px; padding: 6px 10px; font-size: 10px; cursor: pointer; }
    .anrrgm-preset-btn .preset-swatch { display:inline-block; width:10px; height:10px; border-radius:999px; margin-right:6px; border:1px solid rgba(255,255,255,.3); vertical-align:-1px; }
    .anrrgm-preset-btn:hover { background: var(--arr-btn-hover-bg); }
    .anrrgm-subheading {
      grid-column: 1 / -1;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.25px;
      color: var(--arr-accent-soft);
      margin-top: -2px;
      margin-bottom: -4px;
    }
    .anrrgm-about-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      color: var(--arr-settings-subtext);
      line-height: 1.45;
      user-select: text;
    }
    .anrrgm-about-content b {
      color: var(--arr-settings-text);
      font-weight: 700;
    }
    .anrrgm-about-source-btn {
      align-self: flex-start;
      text-decoration: none;
      margin-top: 4px;
    }
    .anrrgm-settings-actions { display:flex; justify-content:space-between; align-items:flex-end; gap:8px; padding: 8px 14px 14px; }
    .anrrgm-settings-actions-group { display:flex; gap:8px; }
    .anrrgm-settings-action-btn {
      min-height: 31px;
      line-height: 1.1;
      white-space: nowrap;
    }
    .anrrgm-config-header-actions {
      position: absolute;
      top: 8px;
      right: 8px;
      display: inline-flex;
      gap: 4px;
    }
    .anrrgm-config-header-actions .anrrgm-close-btn {
      position: static;
    }
    .config-reset-btn {
      width: auto;
      min-width: 44px;
      height: 20px;
      padding: 0 5px;
      font-size: 9px;
      text-transform: lowercase;
      background: rgba(0, 0, 0, 0.16);
      border-color: rgba(255, 255, 255, 0.22);
      color: rgba(255, 255, 255, 0.84);
    }
    .anrrgm-close-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 20px;
      height: 20px;
      border-radius: 5px;
      border: 1px solid var(--arr-outline-color);
      background: rgba(0, 0, 0, 0.25);
      color: var(--arr-icon-color);
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      line-height: 1;
      font-size: 12px;
    }

    .anrrgm-resize-handle {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 14px;
      height: 14px;
      cursor: nwse-resize;
      border-right: 2px solid rgba(255, 110, 110, 0.85);
      border-bottom: 2px solid rgba(255, 110, 110, 0.85);
      border-radius: 0 0 8px 0;
      opacity: 0.9;
    }

    /* Theme layout styles */
    .anrrgm-theme-layout {
      display: grid;
      grid-template-columns: 180px 1fr;
      min-height: 0;
      height: 100%;
    }
    .anrrgm-theme-sidebar {
      border-right: 1px solid rgba(255,255,255,.08);
      padding: 14px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      background: var(--arr-settings-sidebar-bg);
      overflow-y: auto;
    }
    .anrrgm-theme-sidebar::-webkit-scrollbar {
      width: 6px;
    }
    .anrrgm-theme-sidebar::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--arr-outline-color) 50%, transparent);
      border-radius: 999px;
    }
    .anrrgm-theme-categories {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
    }
    .anrrgm-theme-category {
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 10px;
      color: var(--arr-settings-text);
      background: rgba(0,0,0,.2);
      text-align: left;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .anrrgm-theme-category:hover {
      background: var(--arr-btn-hover-bg);
      border-color: rgba(255,255,255,.2);
    }
    .anrrgm-theme-category.active {
      border-color: var(--arr-outline-color);
      background: color-mix(in srgb, var(--arr-topbar-bg-start) 75%, transparent);
      color: #fff;
    }
    .anrrgm-theme-content {
      padding: 14px;
      overflow-y: auto;
      min-height: 0;
    }
    .anrrgm-theme-content::-webkit-scrollbar {
      width: 10px;
    }
    .anrrgm-theme-content::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--arr-outline-color) 70%, transparent);
      border-radius: 999px;
    }
    .anrrgm-theme-section {
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .anrrgm-theme-section.active {
      display: flex;
    }
  `;

  const root = document.createElement("div");
  root.className = "anrrgm-root";

  const shell = document.createElement("div");
  shell.className = "anrrgm-shell";

  const topbar = document.createElement("div");
  topbar.className = "anrrgm-topbar";
  topbar.innerHTML = `
    <div class="anrrgm-brand">
      <img class="anrrgm-logo" src="${CONFIG.logoUrl}" alt="AnRRgm Client logo" />
      <div>
        <div class="title">${CONFIG.title}</div>
        <div class="subtitle">${CONFIG.subtitle}</div>
      </div>
    </div>
    <div class="anrrgm-collapse-row"></div>
    <div class="anrrgm-topbar-right">
      <input class="anrrgm-search" type="text" placeholder="Search utilities..." autocomplete="off" />
      <button class="anrrgm-settings-btn" type="button" title="Open client settings">⚙</button>
      <span class="anrrgm-chip">v${CONFIG.version}</span>
    </div>
  `;

  const searchInput = topbar.querySelector(".anrrgm-search");
  const settingsBtn = topbar.querySelector(".anrrgm-settings-btn");
  const collapseRow = topbar.querySelector(".anrrgm-collapse-row");

  const generalSection = document.createElement("section");
  generalSection.className = "anrrgm-section";
  generalSection.innerHTML = `<div class="anrrgm-section-label">General</div>`;

  const gamemodeSection = document.createElement("section");
  gamemodeSection.className = "anrrgm-section";
  gamemodeSection.innerHTML = `<div class="anrrgm-section-label">Gamemode Specific</div>`;

  const footer = document.createElement("div");
  footer.className = "anrrgm-footer";
  setFooterText();

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "anrrgm-resize-handle";

  const configMenu = document.createElement("div");
  configMenu.className = "anrrgm-config hidden";
  configMenu.innerHTML = `
    <div class="anrrgm-config-header">
      <div class="anrrgm-config-title">Module Config</div>
      <div class="anrrgm-config-sub">Configure this module.</div>
    </div>
    <div class="anrrgm-config-header-actions">
      <button class="anrrgm-close-btn config-reset-btn" type="button" title="Reset module config">reset</button>
      <button class="anrrgm-close-btn config-close-btn" type="button" title="Close">✕</button>
    </div>
    <div class="anrrgm-config-body">
      <div class="anrrgm-config-row">
        <span>Keybind</span>
        <div class="anrrgm-config-actions">
          <button class="anrrgm-btn anrrgm-btn-square" type="button" title="Reset keybind">↺</button>
          <button class="anrrgm-btn" type="button">Set keybind</button>
        </div>
      </div>
    </div>
  `;

  const configBackdrop = document.createElement("div");
  configBackdrop.className = "anrrgm-config-backdrop hidden";
  configBackdrop.appendChild(configMenu);

  const settingsMenu = document.createElement("div");
  settingsMenu.className = "anrrgm-settings hidden";
  settingsMenu.innerHTML = `
    <div class="anrrgm-settings-header">
      <div class="anrrgm-settings-title">Client Settings</div>
      <div class="anrrgm-settings-sub">Customize colors and appearance</div>
    </div>
    <button class="anrrgm-close-btn settings-close-top" type="button" title="Close">✕</button>
    <div class="anrrgm-settings-layout">
      <div class="anrrgm-settings-sidebar">
        <button class="anrrgm-settings-tab active" type="button" data-tab="controls">Controls</button>
        <button class="anrrgm-settings-tab" type="button" data-tab="theme">Theme</button>
        <button class="anrrgm-settings-tab" type="button" data-tab="appearance">Appearance</button>
        <button class="anrrgm-settings-tab" type="button" data-tab="about">About</button>
      </div>
      <div class="anrrgm-settings-pane" data-pane="controls">
        <div class="anrrgm-settings-body">
          <div class="anrrgm-subheading">Menu</div>
          <div class="anrrgm-setting-card">
            <label>Menu Toggle Key</label>
            <button class="anrrgm-keybind-btn settings-menu-key" type="button">Menu Key: ${CONFIG.toggleKey}</button>
            <button class="anrrgm-btn anrrgm-btn-square settings-menu-key-reset" type="button" title="Reset menu key">↺</button>
          </div>
          <div class="anrrgm-subheading">Search</div>
          <div class="anrrgm-setting-card">
            <label>Auto Focus Search</label>
            <input type="checkbox" class="set-search-autofocus" checked />
          </div>
          <div class="anrrgm-subheading">Modules</div>
          <div class="anrrgm-setting-card">
            <label>Hidden Categories (click to toggle)</label>
            <div class="anrrgm-hidden-categories-list"></div>
          </div>
        </div>
      </div>
      <div class="anrrgm-settings-pane hidden" data-pane="theme">
        <div class="anrrgm-settings-body">
          <div class="anrrgm-subheading">Presets</div>
          <div class="anrrgm-preset-row" style="margin-bottom: 14px;">
            <button type="button" class="anrrgm-preset-btn" data-preset="default"><span class="preset-swatch" style="background:#ff3d3d"></span>Default</button>
            <button type="button" class="anrrgm-preset-btn" data-preset="green"><span class="preset-swatch" style="background:#2dff75"></span>Green</button>
            <button type="button" class="anrrgm-preset-btn" data-preset="ice"><span class="preset-swatch" style="background:#6cd8ff"></span>Ice</button>
            <button type="button" class="anrrgm-preset-btn" data-preset="midnight"><span class="preset-swatch" style="background:#9b5cff"></span>Midnight</button>
            <button type="button" class="anrrgm-preset-btn" data-preset="grayscale"><span class="preset-swatch" style="background:#bfbfbf"></span>Greyscale</button>
          </div>
          <div class="anrrgm-subheading">Display Mode</div>
          <div class="anrrgm-settings-actions-group" style="margin-bottom: 14px; margin-top: 8px;">
            <button class="anrrgm-btn set-display-mode" data-display-mode="merged" type="button">Merged</button>
            <button class="anrrgm-btn set-display-mode active" data-display-mode="loose" type="button">Loose</button>
          </div>
        </div>
      </div>
      <div class="anrrgm-settings-pane hidden" data-pane="appearance">
        <div class="anrrgm-settings-body">
          <div class="anrrgm-subheading">Layout & Sizing</div>
          <div class="anrrgm-setting-card">
            <label>UI Scale</label>
            <input type="range" class="set-scale" min="80" max="130" value="100" />
          </div>
          <div class="anrrgm-setting-card">
            <label>Corner Radius</label>
            <input type="range" class="set-radius" min="6" max="20" value="14" />
          </div>
          <div class="anrrgm-setting-card">
            <label>Panel Blur</label>
            <input type="range" class="set-blur" min="0" max="16" value="10" />
          </div>
          <div class="anrrgm-subheading">Motion</div>
          <div class="anrrgm-setting-card">
            <label>Module Hover Shift</label>
            <input type="range" class="set-hover-shift" min="0" max="6" value="2" />
          </div>
          <div class="anrrgm-subheading">Main Window</div>
              <div class="anrrgm-setting-card">
                <label>Accent Color</label>
                <input type="color" class="set-accent" value="#ff3d3d" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Background Gradient</label>
                <span class="anrrgm-gradient-pair">
                  <input type="color" class="set-shell-bg-start" value="#ff3d3d" />
                  <input type="color" class="set-shell-bg-end" value="#000000" />
                </span>
              </div>
              <div class="anrrgm-setting-card">
                <label>Top Bar Color</label>
                <input type="color" class="set-topbar-color" value="#ff4a4a" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Text Color</label>
                <input type="color" class="set-text" value="#d6d6df" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Panel Border</label>
                <input type="color" class="set-border" value="#ff6f6f" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Background Opacity</label>
                <input type="range" class="set-opacity" min="20" max="100" value="45" />
              </div>
          <div class="anrrgm-subheading">Buttons & Inputs</div>
              <div class="anrrgm-setting-card">
                <label>Outline Color</label>
                <input type="color" class="set-outline-color" value="#ff5b5b" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Slider Color</label>
                <input type="color" class="set-slider-color" value="#ff6b6b" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Checkmark Color</label>
                <input type="color" class="set-checkmark-color" value="#ff6b6b" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Dropdown Background</label>
                <input type="color" class="set-select-bg" value="#17171f" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Dropdown Text</label>
                <input type="color" class="set-select-text" value="#ffe5e5" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Text Input Background</label>
                <input type="color" class="set-input-bg" value="#17171f" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Text Input Text</label>
                <input type="color" class="set-input-text" value="#ffe5e5" />
              </div>
          <div class="anrrgm-subheading">Typography</div>
              <div class="anrrgm-setting-card">
                <label>Font Family</label>
                <select class="set-font">
                  <option value="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" selected>Inter (Default)</option>
                  <option value="JetBrains Mono, 'Courier New', monospace">JetBrains Mono</option>
                  <option value="'Segoe UI', Tahoma, Geneva, Verdana, sans-serif">Segoe UI</option>
                  <option value="Roboto, 'Helvetica Neue', Arial, sans-serif">Roboto</option>
                  <option value="'Open Sans', 'Helvetica Neue', Arial, sans-serif">Open Sans</option>
                  <option value="'Fira Code', 'Courier New', monospace">Fira Code</option>
                  <option value="Poppins, 'Helvetica Neue', Arial, sans-serif">Poppins</option>
                </select>
              </div>
              <div class="anrrgm-setting-card">
                <label>Muted Text</label>
                <input type="color" class="set-muted-text" value="#9b9bab" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Label Accent</label>
                <input type="color" class="set-accent-soft" value="#ffbdbd" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Search Text</label>
                <input type="color" class="set-search-text" value="#ffe6e6" />
              </div>
          <div class="anrrgm-subheading">Icons & Badges</div>
              <div class="anrrgm-setting-card">
                <label>Icon Color</label>
                <input type="color" class="set-icon-color" value="#ffdada" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Panel Count Text</label>
                <input type="color" class="set-panel-count-text" value="#ffd9d9" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Panel Count Border</label>
                <input type="color" class="set-panel-count-border" value="#ff6464" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Panel Count Background</label>
                <input type="color" class="set-panel-count-bg" value="#1a1a1e" />
              </div>
          <div class="anrrgm-subheading">Panels & Modules</div>
              <div class="anrrgm-setting-card">
                <label>Module Bar Gradient</label>
                <span class="anrrgm-gradient-pair">
                  <input type="color" class="set-header-start" value="#ff4a4a" />
                  <input type="color" class="set-header-end" value="#3c1212" />
                </span>
              </div>
              <div class="anrrgm-setting-card">
                <label>Module Bar Text</label>
                <input type="color" class="set-header-text" value="#ffffff" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Module Disabled Background</label>
                <input type="color" class="set-module-disabled-bg" value="#000000" />
              </div>
          <div class="anrrgm-subheading">Settings Menu</div>
              <div class="anrrgm-setting-card">
                <label>Settings Header Gradient</label>
                <span class="anrrgm-gradient-pair">
                  <input type="color" class="set-settings-header-start" value="#ff3d3d" />
                  <input type="color" class="set-settings-header-end" value="#2d0c0c" />
                </span>
              </div>
              <div class="anrrgm-setting-card">
                <label>Settings Sidebar Tint</label>
                <input type="color" class="set-settings-sidebar" value="#181820" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Settings Body Tint</label>
                <input type="color" class="set-settings-body" value="#121216" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Settings Text Color</label>
                <input type="color" class="set-settings-text" value="#ffe5e5" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Settings Subtext Color</label>
                <input type="color" class="set-settings-subtext" value="#c2c2ce" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Settings Card Border</label>
                <input type="color" class="set-settings-card-border" value="#ffffff" />
              </div>
              <div class="anrrgm-setting-card">
                <label>Settings Card Background</label>
                <input type="color" class="set-settings-card-bg" value="#ffffff" />
              </div>
              <div class="anrrgm-setting-card">
                <label>ESP Value Text Color</label>
                <input type="color" class="set-esp-value-text-color" value="#ffffff" />
              </div>
        </div>
      </div>
      <div class="anrrgm-settings-pane hidden" data-pane="about">
        <div class="anrrgm-settings-body">
          <div class="anrrgm-subheading">Client Info</div>
          <div class="anrrgm-setting-card">
            <div class="anrrgm-about-content">
              <div><b>AnRRgm Client</b> is a locally extended Gimkit userscript with module toggles, keybinds, theming controls, and Don't Look Down movement tools.</div>
              <div>Based on the MIT-licensed <b>Zyrox Client</b>; original source and author credit are preserved below.</div>
              <div>We are not responsible for any bans, account issues, data loss, or damages that may result from using this client. Use it at your own risk.</div>
              <div>Version: ${CONFIG.version}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <a
                  class="anrrgm-btn anrrgm-about-source-btn"
                  href="https://github.com/Zyrox-client/Zyrox-gimkit-client"
                  target="_blank"
                  rel="noopener noreferrer"
                >Original Zyrox Source</a>
                
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
      <div class="anrrgm-settings-actions">
      <div class="anrrgm-settings-actions-group" style="flex-direction:column;gap:5px;align-items:flex-start;">
        <button class="anrrgm-btn anrrgm-settings-action-btn settings-reset-positions" type="button">Reset Positions</button>
        <button class="anrrgm-btn anrrgm-settings-action-btn settings-reset" type="button">Reset Appearance</button>
        <button class="anrrgm-btn anrrgm-settings-action-btn settings-reset-all" type="button" style="opacity:0.8;">Reset All</button>
      </div>
      <div class="anrrgm-settings-actions-group">
        <button class="anrrgm-btn settings-save" type="button">Save</button>
        <button class="anrrgm-btn settings-close" type="button">Close</button>
      </div>
    </div>
  `;
  configBackdrop.appendChild(settingsMenu);

  function absorbMenuInputEvents(node) {
    if (!node) return;
    const block = (event) => {
      event.stopPropagation();
    };
    ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"].forEach((type) => {
      node.addEventListener(type, block, false);
    });
  }
  absorbMenuInputEvents(root);
  absorbMenuInputEvents(configBackdrop);
  absorbMenuInputEvents(configMenu);
  absorbMenuInputEvents(settingsMenu);

  const configTitleEl = configMenu.querySelector(".anrrgm-config-title");
  const configSubEl = configMenu.querySelector(".anrrgm-config-sub");
  const configCloseBtn = configMenu.querySelector(".config-close-btn");
  const settingsTabs = [...settingsMenu.querySelectorAll(".anrrgm-settings-tab")];
  const settingsPanes = [...settingsMenu.querySelectorAll(".anrrgm-settings-pane")];
  const configBody = configMenu.querySelector(".anrrgm-config-body");
  // Backward-compat alias for legacy code paths that still reference this identifier.
  const setBindButtonEl = configMenu.querySelector(".set-bind-btn");
  const settingsMenuKeyBtn = settingsMenu.querySelector(".settings-menu-key");
  const settingsMenuKeyResetBtn = settingsMenu.querySelector(".settings-menu-key-reset");
  const settingsTopCloseBtn = settingsMenu.querySelector(".settings-close-top");
  const settingsSaveBtn = settingsMenu.querySelector(".settings-save");
  const presetButtons = [...settingsMenu.querySelectorAll(".anrrgm-preset-btn")];
  const searchAutofocusInput = settingsMenu.querySelector(".set-search-autofocus");
  const hiddenCategoriesList = settingsMenu.querySelector(".anrrgm-hidden-categories-list");
  const accentInput = settingsMenu.querySelector(".set-accent");
  const shellBgStartInput = settingsMenu.querySelector(".set-shell-bg-start");
  const shellBgEndInput = settingsMenu.querySelector(".set-shell-bg-end");
  const topbarColorInput = settingsMenu.querySelector(".set-topbar-color");
  const iconColorInput = settingsMenu.querySelector(".set-icon-color");
  const outlineColorInput = settingsMenu.querySelector(".set-outline-color");
  const panelCountTextInput = settingsMenu.querySelector(".set-panel-count-text");
  const panelCountBorderInput = settingsMenu.querySelector(".set-panel-count-border");
  const panelCountBgInput = settingsMenu.querySelector(".set-panel-count-bg");
  const borderInput = settingsMenu.querySelector(".set-border");
  const textInput = settingsMenu.querySelector(".set-text");
  const opacityInput = settingsMenu.querySelector(".set-opacity");
  const sliderColorInput = settingsMenu.querySelector(".set-slider-color");
  const checkmarkColorInput = settingsMenu.querySelector(".set-checkmark-color");
  const selectBgInput = settingsMenu.querySelector(".set-select-bg");
  const selectTextInput = settingsMenu.querySelector(".set-select-text");
  const inputBgInput = settingsMenu.querySelector(".set-input-bg");
  const inputTextInput = settingsMenu.querySelector(".set-input-text");
  const mutedTextInput = settingsMenu.querySelector(".set-muted-text");
  const accentSoftInput = settingsMenu.querySelector(".set-accent-soft");
  const searchTextInput = settingsMenu.querySelector(".set-search-text");
  const fontInput = settingsMenu.querySelector(".set-font");
  const headerStartInput = settingsMenu.querySelector(".set-header-start");
  const headerEndInput = settingsMenu.querySelector(".set-header-end");
  const headerTextInput = settingsMenu.querySelector(".set-header-text");
  const moduleDisabledBgInput = settingsMenu.querySelector(".set-module-disabled-bg");
  const settingsHeaderStartInput = settingsMenu.querySelector(".set-settings-header-start");
  const settingsHeaderEndInput = settingsMenu.querySelector(".set-settings-header-end");
  const settingsSidebarInput = settingsMenu.querySelector(".set-settings-sidebar");
  const settingsBodyInput = settingsMenu.querySelector(".set-settings-body");
  const settingsTextInput = settingsMenu.querySelector(".set-settings-text");
  const settingsSubtextInput = settingsMenu.querySelector(".set-settings-subtext");
  const settingsCardBorderInput = settingsMenu.querySelector(".set-settings-card-border");
  const settingsCardBgInput = settingsMenu.querySelector(".set-settings-card-bg");
  const espValueTextColorInput = settingsMenu.querySelector(".set-esp-value-text-color");
  const scaleInput = settingsMenu.querySelector(".set-scale");
  const radiusInput = settingsMenu.querySelector(".set-radius");
  const blurInput = settingsMenu.querySelector(".set-blur");
  const hoverShiftInput = settingsMenu.querySelector(".set-hover-shift");
  const displayModeButtons = [...settingsMenu.querySelectorAll(".set-display-mode")];
  const settingsResetPositionsBtn = settingsMenu.querySelector(".settings-reset-positions");
  const settingsResetBtn = settingsMenu.querySelector(".settings-reset");
  const settingsResetAllBtn = settingsMenu.querySelector(".settings-reset-all");
  const settingsCloseBtn = settingsMenu.querySelector(".settings-close");
  const panelByName = new Map();
  const configResetBtn = configMenu.querySelector(".config-reset-btn");
  const panelCollapseButtons = new Map();
  let openConfigModule = null;
  let currentSetBindBtn = null;
  let currentResetBindBtn = null;
  let currentBindTextEl = null;

  function setBindButtonText(text) {
    const bindButton = currentSetBindBtn || setBindButtonEl || configMenu.querySelector(".set-bind-btn");
    if (bindButton) bindButton.textContent = text;
  }

  function setFooterText() {
    footer.innerHTML = DEFAULT_FOOTER_HTML();
  }

  function setCurrentBindText(bind) {
    if (!currentBindTextEl) return;
    currentBindTextEl.textContent = bind ? `Keybind: ${bind}` : "Keybind: none";
  }

  function getModuleLayoutConfig(moduleName) {
    const allGroups = [...MENU_LAYOUT.general.groups, ...MENU_LAYOUT.gamemodeSpecific.groups];
    const found = allGroups
      .flatMap((group) => group.modules || [])
      .find((mod) => typeof mod === "object" && mod && mod.name === moduleName);
    return found || null;
  }

  function getModuleDescription(moduleName) {
    const layout = getModuleLayoutConfig(moduleName);
    if (layout?.description) return layout.description;
    return MODULE_DESCRIPTIONS[moduleName] || "Configure this module.";
  }

  function ensureModuleConfigStore() {
    if (state.moduleConfig instanceof Map) return state.moduleConfig;

    const recovered = new Map();
    if (state.moduleConfig && typeof state.moduleConfig === "object") {
      for (const [moduleName, cfg] of Object.entries(state.moduleConfig)) {
        if (cfg && typeof cfg === "object") {
          recovered.set(moduleName, { ...cfg, keybind: cfg.keybind || null, hold: Boolean(cfg.hold) });
        }
      }
    }
    state.moduleConfig = recovered;
    return state.moduleConfig;
  }

  function moduleCfg(name) {
    const store = ensureModuleConfigStore();
    const layout = getModuleLayoutConfig(name);
    if (!store.has(name)) {
      const settings = {};
      if (layout && Array.isArray(layout.settings)) {
        for (const setting of layout.settings) {
          settings[setting.id] = setting.default ?? setting.min ?? 0;
        }
      }
      store.set(name, { keybind: null, hold: false, ...settings });
    }
    const cfg = store.get(name);
    if (cfg && typeof cfg === "object") {
      if (cfg.keybind === undefined) cfg.keybind = null;
      if (cfg.hold === undefined) cfg.hold = false;
    }
    if (cfg && layout && Array.isArray(layout.settings)) {
      for (const setting of layout.settings) {
        if (cfg[setting.id] !== undefined) continue;
        cfg[setting.id] = setting.default ?? setting.min ?? 0;
      }
    }
    if (name === "ESP") {
      window.__anrrgmEspConfig = { ...getEspRenderConfig(), ...cfg };
    } else if (name === "Triggerbot (Autoshoot)") {
      window.__anrrgmTriggerAssistConfig = { ...getTriggerAssistConfig(), ...cfg };
    } else if (name === "Quick Fire") {
      window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
    } else if (name === "Aimbot") {
      window.__anrrgmAutoAimConfig = { ...getAutoAimConfig(), ...cfg };
    } else if (name === "Auto Answer") {
      window.__anrrgmAutoAnswerConfig = { ...cfg };
    } else if (name === KEYSTROKES_MODULE_NAME) {
      keystrokesState.config = { ...cfg };
      window.__anrrgmKeystrokesConfig = { ...cfg };
    }
    return cfg;
  }


  function setBindLabel(item, moduleName) {
    const label = item.querySelector(".anrrgm-bind-label");
    const bind = moduleCfg(moduleName).keybind;
    label.textContent = bind || "";
    label.style.display = bind ? "" : "none";
  }

  function setModuleEnabled(moduleName, enabled, { persist = true } = {}) {
    const item = state.moduleItems.get(moduleName);
    const moduleInstance = state.modules.get(moduleName);
    if (!item || !moduleInstance) return;
    if (enabled === moduleInstance.enabled) return;

    if (enabled) {
      moduleInstance.enable();
      item.classList.add("active");
      state.enabledModules.add(moduleName);
      if (moduleName === "Auto Answer") startAutoAnswer();
    } else {
      moduleInstance.disable();
      item.classList.remove("active");
      state.enabledModules.delete(moduleName);
      if (moduleName === "Auto Answer") stopAutoAnswer();
    }
    if (persist) saveSettings();
  }

  function toggleModule(moduleName, options) {
    const moduleInstance = state.modules.get(moduleName);
    if (!moduleInstance) return;
    setModuleEnabled(moduleName, !moduleInstance.enabled, options);
  }

  // ---------------------------------------------------------------------------
  // AUTO-ANSWER MODULE CONTROLS
  // The actual logic runs in page context (injected above).
  // These functions just start/stop the interval via window.__anrrgmAutoAnswer.
  // ---------------------------------------------------------------------------
  function stopAutoAnswer() {
    window.__anrrgmAutoAnswer?.stop();
  }

  function startAutoAnswer() {
    const cfg = moduleCfg("Auto Answer");
    const speed = Math.max(200, Number(cfg.speed) || 1000);
    const triviaDelayNumber = Number(cfg.triviaDelay);
    const triviaDelay = Math.max(0, Math.min(8000, Number.isFinite(triviaDelayNumber) ? triviaDelayNumber : 1500));
    window.__anrrgmAutoAnswer?.start(speed, { pardyDelay: triviaDelay });
  }

  function refreshAutoAnswerLoopIfEnabled() {
    if (state.enabledModules.has("Auto Answer")) startAutoAnswer();
  }

  function getAnswerPopupConfig() {
    const cfg = moduleCfg("Answer Popup");
    return {
      title: String(cfg.title ?? "Draw It Answer"),
      prefix: String(cfg.prefix ?? "Answer:"),
      durationMs: Math.max(400, Number(cfg.durationMs) || 2600),
      background: String(cfg.background ?? "#121525"),
      accent: String(cfg.accent ?? "#00e5ff"),
      textColor: String(cfg.textColor ?? "#ffffff"),
    };
  }

  function ensureAnswerPopupContainer() {
    if (answerPopupState.container?.isConnected) return answerPopupState.container;
    const popup = document.createElement("div");
    popup.className = "anrrgm-answer-popup";
    popup.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:92px",
      "transform:translate(-50%, -18px)",
      "min-width:260px",
      "max-width:min(86vw,640px)",
      "padding:12px 14px",
      "border-radius:12px",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif",
      "z-index:2147483647",
      "opacity:0",
      "pointer-events:none",
      "transition:opacity .18s ease, transform .18s ease",
      "box-shadow:0 14px 34px rgba(0,0,0,.45)",
      "border:1px solid rgba(255,255,255,.14)",
      "display:none",
      "white-space:normal",
      "overflow-wrap:anywhere",
    ].join(";");
    document.documentElement.appendChild(popup);
    answerPopupState.container = popup;
    return popup;
  }

  function showAnswerPopup(answerText) {
    if (!answerPopupState.enabled) return;
    const answer = String(answerText || "").trim();
    if (!answer) return;
    const now = Date.now();
    if (answer === answerPopupState.lastAnswer && now - answerPopupState.lastShownAt < 700) return;
    answerPopupState.lastAnswer = answer;
    answerPopupState.lastShownAt = now;

    const popup = ensureAnswerPopupContainer();
    const cfg = getAnswerPopupConfig();
    popup.style.background = cfg.background;
    popup.style.color = cfg.textColor;
    popup.style.borderLeft = `4px solid ${cfg.accent}`;
    popup.innerHTML = `
      <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.75;margin-bottom:4px;">${cfg.title}</div>
      <div style="font-size:16px;font-weight:700;line-height:1.25;">${cfg.prefix} <span style="color:${cfg.accent};">${answer}</span></div>
    `;

    popup.style.display = "block";
    popup.style.opacity = "1";
    popup.style.transform = "translate(-50%, 0)";
    if (answerPopupState.timeoutId) clearTimeout(answerPopupState.timeoutId);
    answerPopupState.timeoutId = setTimeout(() => {
      popup.style.opacity = "0";
      popup.style.transform = "translate(-50%, -18px)";
      setTimeout(() => {
        if (popup.style.opacity === "0") popup.style.display = "none";
      }, 180);
    }, cfg.durationMs);
  }


  function resetModuleConfig(moduleName) {
    if (!moduleName) return;
    const store = ensureModuleConfigStore();
    store.delete(moduleName);
    const freshCfg = moduleCfg(moduleName);
    const module = state.modules.get(moduleName);
    const behavior = MODULE_BEHAVIORS[moduleName];
    if (module?.enabled) {
      try { behavior?.onDisable?.(); } catch (error) { console.error(`[AnRRgm] ${moduleName} failed to disable during config reset`, error); }
      try { behavior?.onEnable?.(); } catch (error) { console.error(`[AnRRgm] ${moduleName} failed to re-enable during config reset`, error); }
    }
    const item = state.moduleItems.get(moduleName);
    if (item) setBindLabel(item, moduleName);
    setCurrentBindText(freshCfg.keybind || null);
    state.listeningForBind = null;
    setBindButtonText("Set keybind");
    saveSettings();
  }

  function closeConfig() {
    configBody.__anrrgmStylesConfigAbort?.abort?.();
    configBody.__anrrgmStylesConfigAbort = null;
    configBackdrop.classList.add("hidden");
    configMenu.classList.add("hidden");
    settingsMenu.classList.add("hidden");
    openConfigModule = null;
    currentBindTextEl = null;
    state.listeningForBind = null;
    setBindButtonText("Set keybind");
  }

  function openConfig(moduleName) {
    openConfigModule = moduleName;
    configBody.__anrrgmStylesConfigAbort?.abort?.();
    configBody.__anrrgmStylesConfigAbort = null;
    const cfg = moduleCfg(moduleName);
    const moduleLayout = getModuleLayoutConfig(moduleName);
    if (moduleName === STYLES_MODULE_NAME) attachStylesConfigLiveSync(configBody);

    configBody.innerHTML = `
      <div class="anrrgm-config-row">
        <span class="anrrgm-keybind-current">Keybind: ${cfg.keybind || "none"}</span>
        <label class="anrrgm-hold-toggle" title="Only enable this module while its keybind is held down">
          <input type="checkbox" class="hold-bind-checkbox" ${cfg.hold ? "checked" : ""} />
          <span>Hold</span>
        </label>
        <div class="anrrgm-config-actions">
          <button class="anrrgm-btn anrrgm-btn-square reset-bind-btn" type="button" title="Reset keybind">↺</button>
          <button class="anrrgm-btn set-bind-btn" type="button">Set keybind</button>
        </div>
      </div>
    `;

    currentResetBindBtn = configMenu.querySelector(".reset-bind-btn");
    currentSetBindBtn = configMenu.querySelector(".set-bind-btn");
    currentBindTextEl = configMenu.querySelector(".anrrgm-keybind-current");
    const currentHoldBindCheckbox = configMenu.querySelector(".hold-bind-checkbox");

    if (currentHoldBindCheckbox) {
      currentHoldBindCheckbox.addEventListener("change", (event) => {
        if (!openConfigModule) return;
        const activeCfg = moduleCfg(openConfigModule);
        activeCfg.hold = Boolean(event.target.checked);
        if (activeCfg.hold) setModuleEnabled(openConfigModule, false, { persist: false });
        saveSettings();
      });
    }

    if (currentSetBindBtn) {
      currentSetBindBtn.addEventListener("click", () => {
        if (!openConfigModule) return;
        state.listeningForBind = openConfigModule;
        setBindButtonText("Press any key...");
      });
    }

    if (currentResetBindBtn) {
      currentResetBindBtn.addEventListener("click", () => {
        if (!openConfigModule) return;
        const activeCfg = moduleCfg(openConfigModule);
        activeCfg.keybind = null;
        const item = state.moduleItems.get(openConfigModule);
        if (item) setBindLabel(item, openConfigModule);
        setCurrentBindText(null);
        state.listeningForBind = null;
        setBindButtonText("Set keybind");
        saveSettings();
      });
    }


    if (moduleName === STYLES_MODULE_NAME) {
      Object.assign(cfg, getStylesConfigStore() || QUESTION_STYLES_DEFAULTS);

      const presetCard = document.createElement("div");
      presetCard.className = "anrrgm-setting-card";
      presetCard.style.alignItems = "stretch";
      presetCard.style.flexDirection = "column";
      presetCard.style.gap = "8px";
      const presetButtonsHtml = Object.entries(QUESTION_STYLES_PRESETS)
        .map(([value, preset]) => {
          const swatchColor = isStylesHexColor(preset.values?.questionBackground, QUESTION_STYLES_DEFAULTS.questionBackground);
          return `<button type="button" class="anrrgm-btn styles-preset-btn" data-style-preset="${value}" style="flex:1 1 120px;justify-content:center;"><span class="preset-swatch" style="display:inline-block;width:13px;height:13px;border-radius:999px;margin-right:7px;border:1px solid rgba(255,255,255,.36);background:${swatchColor};vertical-align:-2px;"></span>${preset.label}</button>`;
        })
        .join("");
      presetCard.innerHTML = `
        <label style="font-weight:700;">Presets</label>
        <div class="styles-preset-buttons" style="display:flex;gap:8px;flex-wrap:wrap;">${presetButtonsHtml}</div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:700;margin-top:2px;">
          <input type="checkbox" class="styles-use-global-theme" ${cfg.useGlobalTheme ? "checked" : ""} />
          Use global theme
        </label>
      `;
      configBody.appendChild(presetCard);

      const details = document.createElement("details");
      details.className = "anrrgm-setting-card styles-advanced-settings";
      details.style.display = "block";
      details.style.padding = "0";
      details.style.overflow = "hidden";
      details.innerHTML = `
        <summary style="cursor:pointer;list-style:none;padding:10px;font-weight:700;display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="font-size:12px;">Advanced color and size settings</span>
          <span class="styles-advanced-icon" aria-hidden="true" style="font-size:14px;opacity:.8;transition:transform .15s ease;">▸</span>
        </summary>
        <div class="styles-advanced-body" style="display:flex;flex-direction:column;gap:8px;padding:0 10px 10px;"></div>
      `;
      const advancedBody = details.querySelector(".styles-advanced-body");
      const advancedIcon = details.querySelector(".styles-advanced-icon");
      details.addEventListener("toggle", () => {
        if (advancedIcon) advancedIcon.textContent = details.open ? "▾" : "▸";
      });
      const styleSettings = Array.isArray(moduleLayout?.settings) ? moduleLayout.settings : [];

      const makeAdvancedRow = (setting) => {
        const row = document.createElement("div");
        row.className = "anrrgm-setting-card";
        row.style.margin = "0";
        if (setting.type === "color") {
          row.innerHTML = `<label>${setting.label}</label><input type="color" class="styles-live-control" data-setting-id="${setting.id}" value="${cfg[setting.id] ?? setting.default ?? "#ffffff"}" />`;
        } else if (setting.type === "slider") {
          const unit = setting.unit ?? "";
          const value = cfg[setting.id] ?? setting.default ?? setting.min ?? 0;
          row.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
              <span>${setting.label}</span>
              <span class="anrrgm-slider-value" data-value-for="${setting.id}" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${value}${unit}</span>
            </label>
            <input type="range" class="styles-live-control" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" />
          `;
        }
        return row;
      };

      for (const setting of styleSettings) {
        const row = makeAdvancedRow(setting);
        if (row.innerHTML.trim()) advancedBody.appendChild(row);
      }
      configBody.appendChild(details);

      const syncAdvancedControlsFromCfg = () => {
        for (const control of advancedBody.querySelectorAll("[data-setting-id]")) {
          const id = control.dataset.settingId;
          if (cfg[id] === undefined) continue;
          control.value = String(cfg[id]);
          const setting = styleSettings.find((entry) => entry.id === id);
          const valueLabel = advancedBody.querySelector(`[data-value-for="${id}"]`);
          if (valueLabel) valueLabel.textContent = `${cfg[id]}${setting?.unit ?? ""}`;
        }
      };

      presetCard.querySelector(".styles-preset-buttons")?.addEventListener("click", (event) => {
        const button = event.target?.closest?.("[data-style-preset]");
        if (!(button instanceof HTMLButtonElement)) return;
        applyStylesPresetToConfig(cfg, button.dataset.stylePreset);
        syncAdvancedControlsFromCfg();
        const globalThemeInput = presetCard.querySelector(".styles-use-global-theme");
        if (globalThemeInput instanceof HTMLInputElement) globalThemeInput.checked = Boolean(cfg.useGlobalTheme);
        refreshQuestionStylesAfterConfigChange();
        saveSettings();
      });

      const globalThemeInput = presetCard.querySelector(".styles-use-global-theme");
      if (globalThemeInput instanceof HTMLInputElement) {
        globalThemeInput.addEventListener("change", () => {
          cfg.useGlobalTheme = Boolean(globalThemeInput.checked);
          refreshQuestionStylesAfterConfigChange();
          saveSettings();
        });
      }

      const updateAdvancedSetting = (event) => {
        const control = event.target?.closest?.("[data-setting-id]");
        if (!(control instanceof HTMLInputElement)) return;
        const id = control.dataset.settingId;
        const setting = styleSettings.find((entry) => entry.id === id);
        if (!setting) return;
        cfg[id] = control.type === "range" ? Number(control.value) : String(control.value || "#ffffff");
        const valueLabel = advancedBody.querySelector(`[data-value-for="${id}"]`);
        if (valueLabel) valueLabel.textContent = `${cfg[id]}${setting.unit ?? ""}`;
        refreshQuestionStylesAfterConfigChange();
        saveSettings();
      };
      advancedBody.addEventListener("input", updateAdvancedSetting);
      advancedBody.addEventListener("change", updateAdvancedSetting);
    } else if (moduleName === "ESP") {
      const defaults = getEspRenderConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__anrrgmEspConfig = { ...cfg };

      const tabButtons = document.createElement("div");
      tabButtons.style.display = "flex";
      tabButtons.style.gap = "8px";
      tabButtons.style.marginBottom = "8px";
      const enemiesTabBtn = document.createElement("button");
      enemiesTabBtn.className = "anrrgm-btn";
      enemiesTabBtn.type = "button";
      enemiesTabBtn.textContent = "Enemies";
      const teammatesTabBtn = document.createElement("button");
      teammatesTabBtn.className = "anrrgm-btn";
      teammatesTabBtn.type = "button";
      teammatesTabBtn.textContent = "Teammates";
      tabButtons.append(enemiesTabBtn, teammatesTabBtn);
      configBody.appendChild(tabButtons);

      const enemiesPane = document.createElement("div");
      enemiesPane.style.display = "flex";
      enemiesPane.style.flexDirection = "column";
      enemiesPane.style.gap = "8px";
      const teammatesPane = document.createElement("div");
      teammatesPane.style.display = "none";
      teammatesPane.style.flexDirection = "column";
      teammatesPane.style.gap = "8px";
      configBody.append(enemiesPane, teammatesPane);

      const setEspTab = (tab) => {
        const isEnemies = tab !== "teammates";
        enemiesPane.style.display = isEnemies ? "flex" : "none";
        teammatesPane.style.display = isEnemies ? "none" : "flex";
        enemiesTabBtn.style.opacity = isEnemies ? "1" : "0.65";
        teammatesTabBtn.style.opacity = isEnemies ? "0.65" : "1";
      };
      enemiesTabBtn.addEventListener("click", () => setEspTab("enemies"));
      teammatesTabBtn.addEventListener("click", () => setEspTab("teammates"));
      setEspTab("enemies");

      const makeRow = (container, title, html) => {
        const row = document.createElement("div");
        row.className = "anrrgm-setting-card";
        row.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;width:100%;">
            <label style="font-weight:600;">${title}</label>
            ${html}
          </div>
        `;
        container.appendChild(row);
        return row;
      };

      const enemyFilterRow = makeRow(enemiesPane, "Enemy Visibility", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-show-enemies" ${cfg.showEnemies !== false ? "checked" : ""} />
            Show enemies
          </label>
        </div>
      `);

      const hitboxRow = makeRow(enemiesPane, "Hitbox", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-hitbox-enabled" ${cfg.hitbox ? "checked" : ""} /> Enabled</label>
          <label>Size <input type="range" class="esp-hitbox-size" min="24" max="270" step="2" value="${cfg.hitboxSize}" /></label>
          <span class="esp-hitbox-size-value esp-value-text">${cfg.hitboxSize}px</span>
          <label>Width <input type="range" class="esp-hitbox-width" min="1" max="10" step="1" value="${cfg.hitboxWidth}" /></label>
          <span class="esp-hitbox-width-value esp-value-text">${cfg.hitboxWidth}px</span>
          <input type="color" class="esp-hitbox-color" value="${cfg.hitboxColor}" />
        </div>
      `);

      const namesRow = makeRow(enemiesPane, "Names", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-name-show-name" ${resolveNameDistanceVisibility(cfg, false).showName ? "checked" : ""} /> Name</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-name-show-distance" ${resolveNameDistanceVisibility(cfg, false).showDistance ? "checked" : ""} /> Distance</label>
          <label>Size <input type="range" class="esp-name-size" min="10" max="32" step="1" value="${cfg.nameSize}" /></label>
          <span class="esp-name-size-value esp-value-text">${cfg.nameSize}px</span>
          <input type="color" class="esp-name-color" value="${cfg.nameColor}" />
          <label>Distance Style
            <select class="esp-name-distance-style">
              <option value="dot" ${cfg.nameDistanceStyle === "dot" ? "selected" : ""}>Name • 120m</option>
              <option value="dash" ${cfg.nameDistanceStyle === "dash" ? "selected" : ""}>Name - 120m</option>
              <option value="pipe" ${cfg.nameDistanceStyle === "pipe" ? "selected" : ""}>Name | 120m</option>
              <option value="paren" ${cfg.nameDistanceStyle === "paren" ? "selected" : ""}>Name (120m)</option>
              <option value="distanceFirst" ${cfg.nameDistanceStyle === "distanceFirst" ? "selected" : ""}>120m • Name</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-name-outline-enabled" ${cfg.nameOutline !== false ? "checked" : ""} /> Outline</label>
          <label>Outline Width <input type="range" class="esp-name-outline-width" min="1" max="6" step="1" value="${cfg.nameOutlineWidth}" /></label>
          <span class="esp-name-outline-width-value esp-value-text">${cfg.nameOutlineWidth}px</span>
          <input type="color" class="esp-name-outline-color" value="${cfg.nameOutlineColor || "#000000"}" />
        </div>
      `);

      const offscreenRow = makeRow(enemiesPane, "Off-screen", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label>Mode
            <select class="esp-offscreen-style">
              <option value="none" ${cfg.offscreenStyle === "none" ? "selected" : ""}>None</option>
              <option value="tracers" ${cfg.offscreenStyle === "tracers" ? "selected" : ""}>Tracers</option>
              <option value="arrows" ${cfg.offscreenStyle === "arrows" ? "selected" : ""}>Arrows</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-always-tracer" ${cfg.alwaysTracer ? "checked" : ""} />
            Always Show Tracer
          </label>
          <label>Theme
            <select class="esp-offscreen-theme">
              <option value="classic" ${cfg.offscreenTheme === "classic" ? "selected" : ""}>Classic</option>
              <option value="dashed" ${cfg.offscreenTheme === "dashed" ? "selected" : ""}>Dashed</option>
              <option value="neon" ${cfg.offscreenTheme === "neon" ? "selected" : ""}>Neon</option>
            </select>
          </label>
          <span class="esp-tracer-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Tracer Width <input type="range" class="esp-tracer-width" min="1" max="8" step="1" value="${cfg.tracerWidth}" /></label>
            <span class="esp-tracer-width-value esp-value-text">${cfg.tracerWidth}px</span>
            <input type="color" class="esp-tracer-color" value="${cfg.tracerColor}" />
          </span>
          <span class="esp-arrow-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Arrow Size <input type="range" class="esp-arrow-size" min="8" max="30" step="1" value="${cfg.arrowSize}" /></label>
            <span class="esp-arrow-size-value esp-value-text">${cfg.arrowSize}px</span>
            <input type="color" class="esp-arrow-color" value="${cfg.arrowColor}" />
            <label>Arrow Style
              <select class="esp-arrow-style">
                <option value="regular" ${cfg.arrowStyle === "regular" ? "selected" : ""}>Regular Arrow</option>
                <option value="dot" ${cfg.arrowStyle === "dot" ? "selected" : ""}>Dot</option>
                <option value="modern" ${cfg.arrowStyle === "modern" ? "selected" : ""}>Modern Arrow</option>
              </select>
            </label>
          </span>
        </div>
      `);

      const teammateFilterRow = makeRow(teammatesPane, "Teammate Visibility", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-show-teammates" ${cfg.showTeammates !== false ? "checked" : ""} />
            Show teammates
          </label>
        </div>
      `);

      const teammateHitboxRow = makeRow(teammatesPane, "Hitbox", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-hitbox-enabled" ${cfg.teammateHitbox ? "checked" : ""} /> Enabled</label>
          <label>Size <input type="range" class="esp-teammate-hitbox-size" min="24" max="270" step="2" value="${cfg.teammateHitboxSize}" /></label>
          <span class="esp-teammate-hitbox-size-value esp-value-text">${cfg.teammateHitboxSize}px</span>
          <label>Width <input type="range" class="esp-teammate-hitbox-width" min="1" max="10" step="1" value="${cfg.teammateHitboxWidth}" /></label>
          <span class="esp-teammate-hitbox-width-value esp-value-text">${cfg.teammateHitboxWidth}px</span>
          <input type="color" class="esp-teammate-hitbox-color" value="${cfg.teammateHitboxColor || "#36d17c"}" />
        </div>
      `);

      const teammateNamesRow = makeRow(teammatesPane, "Names", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-name-show-name" ${resolveNameDistanceVisibility(cfg, true).showName ? "checked" : ""} /> Name</label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-name-show-distance" ${resolveNameDistanceVisibility(cfg, true).showDistance ? "checked" : ""} /> Distance</label>
          <label>Size <input type="range" class="esp-teammate-name-size" min="10" max="32" step="1" value="${cfg.teammateNameSize}" /></label>
          <span class="esp-teammate-name-size-value esp-value-text">${cfg.teammateNameSize}px</span>
          <input type="color" class="esp-teammate-name-color" value="${cfg.teammateNameColor || "#baf7d2"}" />
          <label>Distance Style
            <select class="esp-teammate-name-distance-style">
              <option value="dot" ${cfg.teammateNameDistanceStyle === "dot" ? "selected" : ""}>Name • 120m</option>
              <option value="dash" ${cfg.teammateNameDistanceStyle === "dash" ? "selected" : ""}>Name - 120m</option>
              <option value="pipe" ${cfg.teammateNameDistanceStyle === "pipe" ? "selected" : ""}>Name | 120m</option>
              <option value="paren" ${cfg.teammateNameDistanceStyle === "paren" ? "selected" : ""}>Name (120m)</option>
              <option value="distanceFirst" ${cfg.teammateNameDistanceStyle === "distanceFirst" ? "selected" : ""}>120m • Name</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="esp-teammate-name-outline-enabled" ${cfg.teammateNameOutline !== false ? "checked" : ""} /> Outline</label>
          <label>Outline Width <input type="range" class="esp-teammate-name-outline-width" min="1" max="6" step="1" value="${cfg.teammateNameOutlineWidth}" /></label>
          <span class="esp-teammate-name-outline-width-value esp-value-text">${cfg.teammateNameOutlineWidth}px</span>
          <input type="color" class="esp-teammate-name-outline-color" value="${cfg.teammateNameOutlineColor || "#ffffff"}" />
        </div>
      `);

      const teammateOffscreenRow = makeRow(teammatesPane, "Off-screen", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label>Mode
            <select class="esp-teammate-offscreen-style">
              <option value="none" ${cfg.teammateOffscreenStyle === "none" ? "selected" : ""}>None</option>
              <option value="tracers" ${cfg.teammateOffscreenStyle === "tracers" ? "selected" : ""}>Tracers</option>
              <option value="arrows" ${cfg.teammateOffscreenStyle === "arrows" ? "selected" : ""}>Arrows</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="esp-teammate-always-tracer" ${cfg.teammateAlwaysTracer ? "checked" : ""} />
            Always Show Tracer
          </label>
          <label>Theme
            <select class="esp-teammate-offscreen-theme">
              <option value="classic" ${cfg.teammateOffscreenTheme === "classic" ? "selected" : ""}>Classic</option>
              <option value="dashed" ${cfg.teammateOffscreenTheme === "dashed" ? "selected" : ""}>Dashed</option>
              <option value="neon" ${cfg.teammateOffscreenTheme === "neon" ? "selected" : ""}>Neon</option>
            </select>
          </label>
          <span class="esp-teammate-tracer-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Tracer Width <input type="range" class="esp-teammate-tracer-width" min="1" max="8" step="1" value="${cfg.teammateTracerWidth}" /></label>
            <span class="esp-teammate-tracer-width-value esp-value-text">${cfg.teammateTracerWidth}px</span>
            <input type="color" class="esp-teammate-tracer-color" value="${cfg.teammateTracerColor || "#36d17c"}" />
          </span>
          <span class="esp-teammate-arrow-controls" style="display:flex;align-items:center;gap:10px;">
            <label>Arrow Size <input type="range" class="esp-teammate-arrow-size" min="8" max="30" step="1" value="${cfg.teammateArrowSize}" /></label>
            <span class="esp-teammate-arrow-size-value esp-value-text">${cfg.teammateArrowSize}px</span>
            <input type="color" class="esp-teammate-arrow-color" value="${cfg.teammateArrowColor || "#36d17c"}" />
            <label>Arrow Style
              <select class="esp-teammate-arrow-style">
                <option value="regular" ${cfg.teammateArrowStyle === "regular" ? "selected" : ""}>Regular Arrow</option>
                <option value="dot" ${cfg.teammateArrowStyle === "dot" ? "selected" : ""}>Dot</option>
                <option value="modern" ${cfg.teammateArrowStyle === "modern" ? "selected" : ""}>Modern Arrow</option>
              </select>
            </label>
          </span>
        </div>
      `);

      const syncEsp = () => {
        window.__anrrgmEspConfig = { ...cfg };
        saveSettings();
      };
      syncEsp();
      const applyValueTextColor = () => {
        for (const el of configBody.querySelectorAll(".esp-value-text")) {
          el.style.color = cfg.valueTextColor || "#ffffff";
        }
      };
      applyValueTextColor();

      const bindCheckbox = (root, selector, key) => {
        const input = root.querySelector(selector);
        if (!input) return;
        input.addEventListener("change", (event) => {
          cfg[key] = Boolean(event.target.checked);
          syncEsp();
        });
      };
      const bindColor = (root, selector, key) => {
        const input = root.querySelector(selector);
        if (!input) return;
        input.addEventListener("input", (event) => {
          cfg[key] = String(event.target.value || "#ffffff");
          syncEsp();
        });
      };
      const bindSlider = (root, selector, key, labelSelector) => {
        const input = root.querySelector(selector);
        const label = root.querySelector(labelSelector);
        if (!input) return;
        input.addEventListener("input", (event) => {
          const value = Number(event.target.value);
          cfg[key] = value;
          if (label) label.textContent = `${value}px`;
          syncEsp();
        });
      };

      bindCheckbox(enemyFilterRow, ".esp-show-enemies", "showEnemies");
      bindCheckbox(hitboxRow, ".esp-hitbox-enabled", "hitbox");
      bindSlider(hitboxRow, ".esp-hitbox-size", "hitboxSize", ".esp-hitbox-size-value");
      bindSlider(hitboxRow, ".esp-hitbox-width", "hitboxWidth", ".esp-hitbox-width-value");
      bindColor(hitboxRow, ".esp-hitbox-color", "hitboxColor");

      bindCheckbox(namesRow, ".esp-name-show-name", "nameTextEnabled");
      bindCheckbox(namesRow, ".esp-name-show-distance", "distanceTextEnabled");
      bindSlider(namesRow, ".esp-name-size", "nameSize", ".esp-name-size-value");
      bindColor(namesRow, ".esp-name-color", "nameColor");
      bindCheckbox(namesRow, ".esp-name-outline-enabled", "nameOutline");
      bindSlider(namesRow, ".esp-name-outline-width", "nameOutlineWidth", ".esp-name-outline-width-value");
      bindColor(namesRow, ".esp-name-outline-color", "nameOutlineColor");
      const nameDistanceStyleInput = namesRow.querySelector(".esp-name-distance-style");
      if (nameDistanceStyleInput) {
        nameDistanceStyleInput.addEventListener("change", (event) => {
          cfg.nameDistanceStyle = String(event.target.value || "dot");
          syncEsp();
        });
      }

      const styleInput = offscreenRow.querySelector(".esp-offscreen-style");
      const tracerControls = offscreenRow.querySelector(".esp-tracer-controls");
      const arrowControls = offscreenRow.querySelector(".esp-arrow-controls");
      const alwaysTracerInput = offscreenRow.querySelector(".esp-always-tracer");
      const refreshIndicatorModeVisibility = () => {
        const mode = cfg.offscreenStyle === "arrows" || cfg.offscreenStyle === "none" ? cfg.offscreenStyle : "tracers";
        if (tracerControls) tracerControls.style.display = mode === "tracers" ? "flex" : "none";
        if (arrowControls) arrowControls.style.display = mode === "arrows" ? "flex" : "none";
      };
      if (styleInput) {
        styleInput.addEventListener("change", (event) => {
          cfg.offscreenStyle = String(event.target.value || "tracers");
          refreshIndicatorModeVisibility();
          syncEsp();
        });
      }
      const themeInput = offscreenRow.querySelector(".esp-offscreen-theme");
      if (themeInput) {
        themeInput.addEventListener("change", (event) => {
          cfg.offscreenTheme = String(event.target.value || "classic");
          syncEsp();
        });
      }
      if (alwaysTracerInput) {
        alwaysTracerInput.addEventListener("change", (event) => {
          cfg.alwaysTracer = Boolean(event.target.checked);
          syncEsp();
        });
      }
      bindSlider(offscreenRow, ".esp-tracer-width", "tracerWidth", ".esp-tracer-width-value");
      bindColor(offscreenRow, ".esp-tracer-color", "tracerColor");
      bindSlider(offscreenRow, ".esp-arrow-size", "arrowSize", ".esp-arrow-size-value");
      bindColor(offscreenRow, ".esp-arrow-color", "arrowColor");
      const arrowStyleInput = offscreenRow.querySelector(".esp-arrow-style");
      if (arrowStyleInput) {
        arrowStyleInput.addEventListener("change", (event) => {
          cfg.arrowStyle = String(event.target.value || "regular");
          syncEsp();
        });
      }
      bindCheckbox(teammateFilterRow, ".esp-show-teammates", "showTeammates");
      bindCheckbox(teammateHitboxRow, ".esp-teammate-hitbox-enabled", "teammateHitbox");
      bindSlider(teammateHitboxRow, ".esp-teammate-hitbox-size", "teammateHitboxSize", ".esp-teammate-hitbox-size-value");
      bindSlider(teammateHitboxRow, ".esp-teammate-hitbox-width", "teammateHitboxWidth", ".esp-teammate-hitbox-width-value");
      bindColor(teammateHitboxRow, ".esp-teammate-hitbox-color", "teammateHitboxColor");
      bindCheckbox(teammateNamesRow, ".esp-teammate-name-show-name", "teammateNameTextEnabled");
      bindCheckbox(teammateNamesRow, ".esp-teammate-name-show-distance", "teammateDistanceTextEnabled");
      bindSlider(teammateNamesRow, ".esp-teammate-name-size", "teammateNameSize", ".esp-teammate-name-size-value");
      bindColor(teammateNamesRow, ".esp-teammate-name-color", "teammateNameColor");
      bindCheckbox(teammateNamesRow, ".esp-teammate-name-outline-enabled", "teammateNameOutline");
      bindSlider(teammateNamesRow, ".esp-teammate-name-outline-width", "teammateNameOutlineWidth", ".esp-teammate-name-outline-width-value");
      bindColor(teammateNamesRow, ".esp-teammate-name-outline-color", "teammateNameOutlineColor");
      const teammateNameDistanceStyleInput = teammateNamesRow.querySelector(".esp-teammate-name-distance-style");
      if (teammateNameDistanceStyleInput) {
        teammateNameDistanceStyleInput.addEventListener("change", (event) => {
          cfg.teammateNameDistanceStyle = String(event.target.value || "dot");
          syncEsp();
        });
      }
      const teammateStyleInput = teammateOffscreenRow.querySelector(".esp-teammate-offscreen-style");
      const teammateTracerControls = teammateOffscreenRow.querySelector(".esp-teammate-tracer-controls");
      const teammateArrowControls = teammateOffscreenRow.querySelector(".esp-teammate-arrow-controls");
      const teammateAlwaysTracerInput = teammateOffscreenRow.querySelector(".esp-teammate-always-tracer");
      const refreshTeammateIndicatorModeVisibility = () => {
        const mode = cfg.teammateOffscreenStyle === "arrows" || cfg.teammateOffscreenStyle === "none"
          ? cfg.teammateOffscreenStyle
          : "tracers";
        if (teammateTracerControls) teammateTracerControls.style.display = mode === "tracers" ? "flex" : "none";
        if (teammateArrowControls) teammateArrowControls.style.display = mode === "arrows" ? "flex" : "none";
      };
      if (teammateStyleInput) {
        teammateStyleInput.addEventListener("change", (event) => {
          cfg.teammateOffscreenStyle = String(event.target.value || "tracers");
          refreshTeammateIndicatorModeVisibility();
          syncEsp();
        });
      }
      const teammateThemeInput = teammateOffscreenRow.querySelector(".esp-teammate-offscreen-theme");
      if (teammateThemeInput) {
        teammateThemeInput.addEventListener("change", (event) => {
          cfg.teammateOffscreenTheme = String(event.target.value || "classic");
          syncEsp();
        });
      }
      if (teammateAlwaysTracerInput) {
        teammateAlwaysTracerInput.addEventListener("change", (event) => {
          cfg.teammateAlwaysTracer = Boolean(event.target.checked);
          syncEsp();
        });
      }
      bindSlider(teammateOffscreenRow, ".esp-teammate-tracer-width", "teammateTracerWidth", ".esp-teammate-tracer-width-value");
      bindColor(teammateOffscreenRow, ".esp-teammate-tracer-color", "teammateTracerColor");
      bindSlider(teammateOffscreenRow, ".esp-teammate-arrow-size", "teammateArrowSize", ".esp-teammate-arrow-size-value");
      bindColor(teammateOffscreenRow, ".esp-teammate-arrow-color", "teammateArrowColor");
      const teammateArrowStyleInput = teammateOffscreenRow.querySelector(".esp-teammate-arrow-style");
      if (teammateArrowStyleInput) {
        teammateArrowStyleInput.addEventListener("change", (event) => {
          cfg.teammateArrowStyle = String(event.target.value || "regular");
          syncEsp();
        });
      }
      refreshIndicatorModeVisibility();
      refreshTeammateIndicatorModeVisibility();
    } else if (moduleName === "Crosshair") {
      const defaults = getCrosshairConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__anrrgmCrosshairConfig = { ...cfg };

      const syncCrosshair = () => { window.__anrrgmCrosshairConfig = { ...cfg }; };
      syncCrosshair();

      const makeRow = (title, html) => {
        const row = document.createElement("div");
        row.className = "anrrgm-setting-card";
        row.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;width:100%;">
            <label style="font-weight:600;">${title}</label>
            ${html}
          </div>
        `;
        configBody.appendChild(row);
        return row;
      };

      const enabledRow = makeRow("Crosshair", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="xh-enabled" ${cfg.enabled !== false ? "checked" : ""} />
            Show Crosshair
          </label>
          <input type="color" class="xh-color" value="${cfg.color || "#ff3b3b"}" title="Crosshair color" />
        </div>
      `);

      const styleRow = makeRow("Style", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <select class="xh-style">
            <option value="cross"       ${cfg.style === "cross"       ? "selected" : ""}>Cross (gap)</option>
            <option value="solid"       ${cfg.style === "solid"       ? "selected" : ""}>Solid Cross</option>
            <option value="crossdot"    ${cfg.style === "crossdot"    ? "selected" : ""}>Cross + Dot</option>
            <option value="dot"         ${cfg.style === "dot"         ? "selected" : ""}>Dot</option>
            <option value="circle"      ${cfg.style === "circle"      ? "selected" : ""}>Circle</option>
            <option value="circlecross" ${cfg.style === "circlecross" ? "selected" : ""}>Circle + Cross</option>
            <option value="plus"        ${cfg.style === "plus"        ? "selected" : ""}>Plus (thick)</option>
            <option value="x"           ${cfg.style === "x"           ? "selected" : ""}>X (diagonal)</option>
          </select>
        </div>
      `);

      const sizeRow = makeRow("Crosshair Size", `
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" class="xh-crosshair-size" min="4" max="40" step="1" value="${cfg.crosshairSize ?? 25}" style="flex:1;" />
          <span class="xh-crosshair-size-label" style="min-width:36px;text-align:right;font-size:0.85em;opacity:0.75;">${cfg.crosshairSize ?? 25}px</span>
        </div>
      `);

      const lineSizeRow = makeRow("Cursor Width", `
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" class="xh-line-size" min="0.5" max="6" step="0.5" value="${cfg.lineSize ?? 4}" style="flex:1;" />
          <span class="xh-line-size-label" style="min-width:36px;text-align:right;font-size:0.85em;opacity:0.75;">${cfg.lineSize ?? 4}px</span>
        </div>
      `);

      const lineRow = makeRow("Line to Cursor", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="xh-show-line" ${cfg.showLine ? "checked" : ""} />
            Show Line
          </label>
          <input type="color" class="xh-line-color" value="${cfg.lineColor || "#ff3b3b"}" title="Line color" />
        </div>
      `);

      const tracerSizeRow = makeRow("Tracer Thickness", `
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" class="xh-tracer-size" min="0.5" max="5" step="0.5" value="${cfg.tracerLineSize ?? 1.5}" style="flex:1;" />
          <span class="xh-tracer-size-label" style="min-width:36px;text-align:right;font-size:0.85em;opacity:0.75;">${cfg.tracerLineSize ?? 1.5}px</span>
        </div>
      `);

      const hoverRow = makeRow("Player Hover", `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="xh-hover-highlight" ${cfg.hoverHighlight ? "checked" : ""} />
            Change color on player
          </label>
          <input type="color" class="xh-hover-color" value="${cfg.hoverColor || "#ffff00"}" title="Hover color" />
        </div>
      `);

      enabledRow.querySelector(".xh-enabled").addEventListener("change", (e) => {
        cfg.enabled = e.target.checked;
        syncCrosshair();
      });
      enabledRow.querySelector(".xh-color").addEventListener("input", (e) => {
        cfg.color = e.target.value;
        syncCrosshair();
      });
      styleRow.querySelector(".xh-style").addEventListener("change", (e) => {
        cfg.style = e.target.value;
        syncCrosshair();
      });
      sizeRow.querySelector(".xh-crosshair-size").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        cfg.crosshairSize = v;
        sizeRow.querySelector(".xh-crosshair-size-label").textContent = `${v}px`;
        syncCrosshair();
      });
      lineSizeRow.querySelector(".xh-line-size").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        cfg.lineSize = v;
        lineSizeRow.querySelector(".xh-line-size-label").textContent = `${v}px`;
        syncCrosshair();
      });
      lineRow.querySelector(".xh-show-line").addEventListener("change", (e) => {
        cfg.showLine = e.target.checked;
        syncCrosshair();
      });
      lineRow.querySelector(".xh-line-color").addEventListener("input", (e) => {
        cfg.lineColor = e.target.value;
        syncCrosshair();
      });
      tracerSizeRow.querySelector(".xh-tracer-size").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        cfg.tracerLineSize = v;
        tracerSizeRow.querySelector(".xh-tracer-size-label").textContent = `${v}px`;
        syncCrosshair();
      });
      hoverRow.querySelector(".xh-hover-highlight").addEventListener("change", (e) => {
        cfg.hoverHighlight = e.target.checked;
        syncCrosshair();
      });
      hoverRow.querySelector(".xh-hover-color").addEventListener("input", (e) => {
        cfg.hoverColor = e.target.value;
        syncCrosshair();
      });

    } else if (moduleName === "Triggerbot (Autoshoot)") {
      const defaults = getTriggerAssistConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__anrrgmTriggerAssistConfig = { ...cfg };

      const syncTriggerAssist = () => {
        window.__anrrgmTriggerAssistConfig = { ...cfg };
        saveSettings();
      };
      syncTriggerAssist();

      for (const setting of moduleLayout?.settings || []) {
        if (setting.type === "checkbox") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = Boolean(setting.default);
          const checked = cfg[setting.id] ? "checked" : "";
          const card = document.createElement("div");
          card.className = "anrrgm-setting-card";
          card.innerHTML = `
            <label>${setting.label}</label>
            <input type="checkbox" class="set-module-setting-checkbox" data-setting-id="${setting.id}" ${checked} />
          `;
          configBody.appendChild(card);
          const input = card.querySelector(".set-module-setting-checkbox");
          input?.addEventListener("change", (event) => {
            cfg[setting.id] = Boolean(event.target.checked);
            syncTriggerAssist();
          });
        } else if (setting.type === "slider") {
          const value = Number(cfg[setting.id] ?? setting.default ?? setting.min ?? 0);
          const unit = setting.unit ?? "ms";
          const card = document.createElement("div");
          card.className = "anrrgm-setting-card";
          card.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;">
              <span>${setting.label}</span>
              <span class="anrrgm-slider-value" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${value}${unit}</span>
            </label>
            <input type="range" class="set-module-setting" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" />
          `;
          configBody.appendChild(card);
          const slider = card.querySelector(".set-module-setting");
          const valueLabel = card.querySelector(".anrrgm-slider-value");
          slider?.addEventListener("input", (event) => {
            const next = Number(event.target.value);
            cfg[setting.id] = next;
            if (valueLabel) valueLabel.textContent = `${next}${unit}`;
            syncTriggerAssist();
          });
        }
      }
    } else if (moduleName === "Aimbot") {
      const defaults = getAutoAimConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      window.__anrrgmAutoAimConfig = { ...cfg };

      const syncAutoAim = () => {
        window.__anrrgmAutoAimConfig = { ...cfg };
        saveSettings();
      };
      syncAutoAim();

      for (const setting of moduleLayout?.settings || []) {
        if (setting.type === "checkbox") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = Boolean(setting.default);
          const checked = cfg[setting.id] ? "checked" : "";
          const card = document.createElement("div");
          card.className = "anrrgm-setting-card";
          card.innerHTML = `
            <label>${setting.label}</label>
            <input type="checkbox" class="set-module-setting-checkbox" data-setting-id="${setting.id}" ${checked} />
          `;
          configBody.appendChild(card);
          const input = card.querySelector(".set-module-setting-checkbox");
          input?.addEventListener("change", (event) => {
            cfg[setting.id] = Boolean(event.target.checked);
            syncAutoAim();
          });
        } else if (setting.type === "slider") {
          const value = Number(cfg[setting.id] ?? setting.default ?? setting.min ?? 0);
          const unit = setting.unit ?? "";
          const card = document.createElement("div");
          card.className = "anrrgm-setting-card";
          card.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;">
              <span>${setting.label}</span>
              <span class="anrrgm-slider-value" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${value}${unit}</span>
            </label>
            <input type="range" class="set-module-setting" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" />
          `;
          configBody.appendChild(card);
          const slider = card.querySelector(".set-module-setting");
          const valueLabel = card.querySelector(".anrrgm-slider-value");
          slider?.addEventListener("input", (event) => {
            const next = Number(event.target.value);
            cfg[setting.id] = next;
            if (valueLabel) valueLabel.textContent = `${next}${unit}`;
            syncAutoAim();
          });
        }
      }
    } else if (moduleName === "Auto Upgrade") {
      const defaults = getAutoUpgradeConfig();
      Object.assign(cfg, { ...defaults, ...cfg });
      const defaultOrder = [...AUTO_UPGRADE_TIE_BREAK_ORDER];
      const configuredOrder = Array.isArray(cfg.order) ? cfg.order.filter((key) => defaultOrder.includes(key)) : [];
      const order = [...configuredOrder];
      for (const key of defaultOrder) if (!order.includes(key)) order.push(key);
      cfg.order = [...order];
      autoUpgradeState.order = [...order];

      const settingCard = document.createElement("div");
      settingCard.style.display = "block";
      settingCard.style.width = "100%";
      settingCard.style.padding = "10px 0";
      settingCard.innerHTML = `<label style="display:block;margin-bottom:8px;">Upgrade Order</label>`;
      const list = document.createElement("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "8px";
      list.style.marginTop = "2px";

      const rowByKey = new Map();
      const createRow = (key) => {
        const row = document.createElement("div");
        row.draggable = true;
        row.dataset.upgradeKey = key;
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "8px 10px";
        row.style.border = "1px solid rgba(255,255,255,.12)";
        row.style.borderRadius = "8px";
        row.style.background = "rgba(0,0,0,.22)";
        row.style.cursor = "grab";
        row.style.transition = "transform .12s ease, border-color .12s ease, background-color .12s ease, opacity .12s ease";
        row.innerHTML = `
          <span style="display:flex;align-items:center;gap:8px;pointer-events:none;">
            <span style="opacity:.7;">☰</span>
            <span>${UPGRADE_HUD_LABELS[key]}</span>
          </span>
          <input type="checkbox" class="set-module-setting-checkbox" style="accent-color:var(--arr-checkmark-color);" data-setting-id="${key}" ${cfg[key] ? "checked" : ""} />
        `;
        row.querySelector(".set-module-setting-checkbox")?.addEventListener("change", (event) => {
          cfg[key] = Boolean(event.target.checked);
          autoUpgradeState.toggles[key] = cfg[key];
          saveSettings();
        });
        rowByKey.set(key, row);
        return row;
      };

      for (const key of order) list.appendChild(createRow(key));
      settingCard.appendChild(list);
      configBody.appendChild(settingCard);

      let draggingKey = null;
      const dropIndicator = document.createElement("div");
      dropIndicator.style.height = "0";
      dropIndicator.style.borderTop = "2px solid var(--arr-slider-color)";
      dropIndicator.style.margin = "0";
      dropIndicator.style.borderRadius = "2px";
      dropIndicator.style.opacity = "0";
      dropIndicator.style.transition = "opacity .1s ease";

      list.addEventListener("dragstart", (event) => {
        const row = event.target.closest("[data-upgrade-key]");
        if (!row) return;
        draggingKey = row.dataset.upgradeKey;
        row.style.opacity = "0.55";
        row.style.transform = "scale(0.985)";
        row.style.borderColor = "var(--arr-slider-color)";
      });
      list.addEventListener("dragend", () => {
        draggingKey = null;
        dropIndicator.remove();
        for (const row of list.querySelectorAll("[data-upgrade-key]")) row.style.opacity = "1";
        for (const row of list.querySelectorAll("[data-upgrade-key]")) {
          row.style.transform = "scale(1)";
          row.style.borderColor = "rgba(255,255,255,.12)";
        }
      });
      list.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (!draggingKey) return;
        const rows = [...list.querySelectorAll("[data-upgrade-key]")].filter((row) => row.dataset.upgradeKey !== draggingKey);
        let insertBeforeRow = null;
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (event.clientY < rect.top + rect.height / 2) {
            insertBeforeRow = row;
            break;
          }
        }
        if (insertBeforeRow) list.insertBefore(dropIndicator, insertBeforeRow);
        else list.appendChild(dropIndicator);
        dropIndicator.style.opacity = "1";
      });
      list.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!draggingKey) return;
        const draggedRow = rowByKey.get(draggingKey);
        if (!draggedRow) return;
        if (dropIndicator.parentElement === list) {
          list.insertBefore(draggedRow, dropIndicator);
        } else {
          const dropTarget = event.target.closest("[data-upgrade-key]");
          if (!dropTarget) list.appendChild(draggedRow);
          else if (dropTarget !== draggedRow) dropTarget.before(draggedRow);
        }
        dropIndicator.remove();
        const nextOrder = [...list.querySelectorAll("[data-upgrade-key]")].map((row) => row.dataset.upgradeKey);
        cfg.order = nextOrder;
        autoUpgradeState.order = [...nextOrder];
        saveSettings();
      });
    } else if (moduleLayout && Array.isArray(moduleLayout.settings)) {
      for (const setting of moduleLayout.settings) {
        const settingCard = document.createElement("div");
        settingCard.className = "anrrgm-setting-card";

        if (setting.type === "slider") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default ?? setting.min ?? 0;
          const initialVal = cfg[setting.id];
          const valueUnit = setting.unit ?? "ms";
          settingCard.innerHTML = `
            <label style="display:flex;justify-content:space-between;align-items:center;">
              <span>${setting.label}</span>
              <span class="anrrgm-slider-value" style="font-size:0.85em;opacity:0.75;min-width:52px;text-align:right;">${initialVal}${valueUnit}</span>
            </label>
            <input type="range" class="set-module-setting" data-setting-id="${setting.id}" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${initialVal}" />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting");
          const valueLabel = settingCard.querySelector(".anrrgm-slider-value");
          if (settingInput) {
            settingInput.addEventListener("input", (event) => {
              const newVal = Number(event.target.value);
              cfg[setting.id] = newVal;
              if (valueLabel) valueLabel.textContent = `${newVal}${valueUnit}`;
              if (moduleName === "Auto Answer" && (setting.id === "speed" || setting.id === "triviaDelay")) {
                // Live-update answer delays only while Auto Answer is enabled
                if (state.enabledModules.has("Auto Answer")) {
                  startAutoAnswer();
                }
              }
              if (moduleName === "Upgrade HUD" && setting.id === "hudSize") {
                let livePos = null;
                if (upgradeHudState.container) {
                  livePos = readHudPositionFromElement(upgradeHudState.container);
                  if (livePos) writeHudPosition("Upgrade HUD", livePos);
                }
                const patch = { hudSize: newVal, ...(livePos ? { hudPosition: { x: Math.round(livePos.x), y: Math.round(livePos.y) } } : {}) };
                const nextCfg = writeUpgradeHudConfigPatch(patch);
                upgradeHudLog("Upgrade HUD setting changed", { settingId: setting.id, value: newVal, livePos, nextCfg });
                renderUpgradeHud(nextCfg);
              }
              if (moduleName === "Building HUD" && setting.id === "hudSize") {
                let livePos = null;
                if (lavaBuildingHudState.container) {
                  livePos = readHudPositionFromElement(lavaBuildingHudState.container);
                  if (livePos) writeHudPosition("Building HUD", livePos);
                }
                const patch = { hudSize: newVal, ...(livePos ? { hudPosition: { x: Math.round(livePos.x), y: Math.round(livePos.y) } } : {}) };
                const nextCfg = writeBuildingHudConfigPatch(patch);
                upgradeHudLog("Building HUD setting changed", { settingId: setting.id, value: newVal, livePos, nextCfg });
                renderLavaBuildingHud(nextCfg);
              }
              if (moduleName === ABILITY_HUD_MODULE_NAME) {
                if (setting.id === "abilityHudScale" || setting.id === "abilityHudGap") {
                  applyAbilityHudLiveConfig({ cfg });
                }
              }
              if (moduleName === CAMERA_ZOOM_MODULE_NAME && setting.id === "zoom") {
                cfg.zoom = clampCameraZoom(newVal);
                if (valueLabel) valueLabel.textContent = `${cfg.zoom}${valueUnit}`;
                if (state.enabledModules.has(CAMERA_ZOOM_MODULE_NAME)) showCameraZoomToast(cfg.zoom);
              }
              if (moduleName === STYLES_MODULE_NAME) {
                refreshQuestionStylesAfterConfigChange();
              }
              if (moduleName === "Quick Fire") {
                window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
                if (quickFireState.enabled) startQuickFire();
              }
              if (moduleName === GAME_FINDER_MODULE_NAME && setting.id === "delay") {
                const nextDelay = setGameFinderDelay(newVal);
                cfg[setting.id] = nextDelay;
                event.target.value = String(nextDelay);
                if (valueLabel) valueLabel.textContent = `${nextDelay}${valueUnit}`;
              }
              if (moduleName === GAME_FINDER_MODULE_NAME && setting.id === "concurrency") {
                const nextConcurrency = setGameFinderConcurrency(newVal);
                cfg[setting.id] = nextConcurrency;
                event.target.value = String(nextConcurrency);
                if (valueLabel) valueLabel.textContent = `${nextConcurrency}${valueUnit}`;
              }
              if (moduleName === KEYSTROKES_MODULE_NAME) syncKeystrokesConfigChange(cfg);
              saveSettings();
            });
            settingInput.addEventListener("change", (event) => {
              const newVal = Number(event.target.value);
              cfg[setting.id] = newVal;
              if (valueLabel) valueLabel.textContent = `${newVal}${valueUnit}`;
              if (moduleName === STYLES_MODULE_NAME) {
                refreshQuestionStylesAfterConfigChange();
              }
              if (moduleName === "Quick Fire") {
                window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
                if (quickFireState.enabled) startQuickFire();
              }
              if (moduleName === GAME_FINDER_MODULE_NAME && setting.id === "delay") {
                const nextDelay = setGameFinderDelay(newVal);
                cfg[setting.id] = nextDelay;
                event.target.value = String(nextDelay);
                if (valueLabel) valueLabel.textContent = `${nextDelay}${valueUnit}`;
              }
              if (moduleName === GAME_FINDER_MODULE_NAME && setting.id === "concurrency") {
                const nextConcurrency = setGameFinderConcurrency(newVal);
                cfg[setting.id] = nextConcurrency;
                event.target.value = String(nextConcurrency);
                if (valueLabel) valueLabel.textContent = `${nextConcurrency}${valueUnit}`;
              }
              if (moduleName === KEYSTROKES_MODULE_NAME) syncKeystrokesConfigChange(cfg);
              saveSettings();
            });
          }
        }

        if (setting.type === "checkbox") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = Boolean(setting.default);
          const checked = cfg[setting.id] ? "checked" : "";
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <input type="checkbox" class="set-module-setting-checkbox" data-setting-id="${setting.id}" ${checked} />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-checkbox");
          if (settingInput) {
            settingInput.addEventListener("change", (event) => {
              cfg[setting.id] = Boolean(event.target.checked);
              if (moduleName === "Upgrade HUD" && (setting.id === "displayTitle" || setting.id === "showLvlPrefix" || setting.id === "showUpgradeButton")) {
                let livePos = null;
                if (upgradeHudState.container) {
                  livePos = readHudPositionFromElement(upgradeHudState.container);
                  if (livePos) writeHudPosition("Upgrade HUD", livePos);
                }
                const patch = { [setting.id]: cfg[setting.id], ...(livePos ? { hudPosition: { x: Math.round(livePos.x), y: Math.round(livePos.y) } } : {}) };
                const nextCfg = writeUpgradeHudConfigPatch(patch);
                upgradeHudLog("Upgrade HUD setting changed", { settingId: setting.id, value: cfg[setting.id], livePos, nextCfg });
                renderUpgradeHud(nextCfg);
              }
              if (moduleName === "Building HUD" && setting.id === "displayTitle") {
                let livePos = null;
                if (lavaBuildingHudState.container) {
                  livePos = readHudPositionFromElement(lavaBuildingHudState.container);
                  if (livePos) writeHudPosition("Building HUD", livePos);
                }
                const patch = { displayTitle: cfg[setting.id], ...(livePos ? { hudPosition: { x: Math.round(livePos.x), y: Math.round(livePos.y) } } : {}) };
                const nextCfg = writeBuildingHudConfigPatch(patch);
                upgradeHudLog("Building HUD setting changed", { settingId: setting.id, value: cfg[setting.id], livePos, nextCfg });
                renderLavaBuildingHud(nextCfg);
              }
              if (moduleName === "Auto Upgrade" && Object.prototype.hasOwnProperty.call(autoUpgradeState.toggles, setting.id)) {
                autoUpgradeState.toggles[setting.id] = Boolean(event.target.checked);
              }
              if (moduleName === ABILITY_HUD_MODULE_NAME && setting.id === "abilityHudShowPrices") {
                applyAbilityHudLiveConfig({ cfg });
              }
              if (moduleName === HIDE_POPUPS_MODULE_NAME) {
                syncHidePopups();
              }
              if (moduleName === STYLES_MODULE_NAME) {
                refreshQuestionStylesAfterConfigChange();
              }
              if (moduleName === "Quick Fire") {
                window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
                if (quickFireState.enabled) startQuickFire();
              }
              if (moduleName === KEYSTROKES_MODULE_NAME) syncKeystrokesConfigChange(cfg);
              saveSettings();
            });
          }
        }

        if (setting.type === "select") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default ?? setting.options?.[0]?.value ?? "";
          const options = Array.isArray(setting.options) ? setting.options : [];
          const optionsHtml = options
            .map((option) => {
              const selected = String(option.value) === String(cfg[setting.id]) ? "selected" : "";
              return `<option value="${option.value}" ${selected}>${option.label}</option>`;
            })
            .join("");
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <select class="set-module-setting-select" data-setting-id="${setting.id}">${optionsHtml}</select>
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-select");
          if (settingInput) {
            settingInput.addEventListener("change", (event) => {
              cfg[setting.id] = String(event.target.value);
              if (moduleName === "Answer Popup" && setting.id === "preset") {
                applyAnswerPopupPreset(cfg, cfg[setting.id]);
                openConfig(moduleName);
              }
              if (moduleName === "Answer Popup") refreshVisibleAnswerPopup();
              if (moduleName === ABILITY_HUD_MODULE_NAME) {
                if (setting.id === "abilityHudDisplayMode") openConfig(moduleName);
                applyAbilityHudLiveConfig({ cfg });
              }
              if (moduleName === STYLES_MODULE_NAME) {
                refreshQuestionStylesAfterConfigChange();
              }
              if (moduleName === "Quick Fire") {
                window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
                if (quickFireState.enabled) startQuickFire();
              }
              saveSettings();
            });
          }
        }

        if (setting.type === "color") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default ?? "#ffffff";
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <input type="color" class="set-module-setting-color" data-setting-id="${setting.id}" value="${cfg[setting.id]}" />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-color");
          if (settingInput) {
            const updateColorSetting = (event) => {
              cfg[setting.id] = String(event.target.value || "#ffffff");
              if (moduleName === "Answer Popup") refreshVisibleAnswerPopup();
              if (moduleName === STYLES_MODULE_NAME) {
                refreshQuestionStylesAfterConfigChange();
              }
              if (moduleName === "Quick Fire") {
                window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
                if (quickFireState.enabled) startQuickFire();
              }
              saveSettings();
            };
            settingInput.addEventListener("input", updateColorSetting);
            settingInput.addEventListener("change", updateColorSetting);
          }
        }

        if (setting.type === "text") {
          if (cfg[setting.id] === undefined) cfg[setting.id] = String(setting.default ?? "");
          const safeValue = String(cfg[setting.id]).replace(/"/g, "&quot;");
          settingCard.innerHTML = `
            <label>${setting.label}</label>
            <input type="text" class="set-module-setting-text" data-setting-id="${setting.id}" value="${safeValue}" />
          `;
          const settingInput = settingCard.querySelector(".set-module-setting-text");
          if (settingInput) {
            settingInput.addEventListener("input", (event) => {
              cfg[setting.id] = String(event.target.value ?? "");
              if (moduleName === STYLES_MODULE_NAME) {
                refreshQuestionStylesAfterConfigChange();
              }
              if (moduleName === "Quick Fire") {
                window.__anrrgmQuickFireConfig = { ...getQuickFireConfig(), ...cfg };
                if (quickFireState.enabled) startQuickFire();
              }
              saveSettings();
            });
          }
        }

        if (settingCard.innerHTML.trim()) configBody.appendChild(settingCard);
      }

      if (moduleName === KEYSTROKES_MODULE_NAME) {
        const details = document.createElement("details");
        details.className = "anrrgm-setting-card keystrokes-advanced-settings";
        details.style.display = "block";
        details.style.padding = "0";
        details.style.overflow = "hidden";
        details.innerHTML = `
          <summary style="cursor:pointer;list-style:none;padding:10px;font-weight:700;display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span style="font-size:12px;">Advanced color settings</span>
            <span class="keystrokes-advanced-icon" aria-hidden="true" style="font-size:14px;opacity:.8;transition:transform .15s ease;">▸</span>
          </summary>
          <div class="keystrokes-advanced-body" style="display:flex;flex-direction:column;gap:8px;padding:0 10px 10px;"></div>
        `;
        const advancedBody = details.querySelector(".keystrokes-advanced-body");
        const advancedIcon = details.querySelector(".keystrokes-advanced-icon");
        details.addEventListener("toggle", () => {
          if (advancedIcon) advancedIcon.textContent = details.open ? "▾" : "▸";
        });

        for (const setting of KEYSTROKES_COLOR_SETTINGS) {
          if (cfg[setting.id] === undefined) cfg[setting.id] = setting.default;
          const row = document.createElement("div");
          row.className = "anrrgm-setting-card";
          row.style.margin = "0";
          row.innerHTML = `<label>${setting.label}</label><input type="color" class="keystrokes-color-control" data-setting-id="${setting.id}" value="${cfg[setting.id] || setting.default}" />`;
          advancedBody?.appendChild(row);
        }

        const updateKeystrokesColorSetting = (event) => {
          const control = event.target?.closest?.("[data-setting-id]");
          if (!(control instanceof HTMLInputElement)) return;
          const setting = KEYSTROKES_COLOR_SETTINGS.find((entry) => entry.id === control.dataset.settingId);
          if (!setting) return;
          cfg[setting.id] = String(control.value || setting.default);
          cfg.useGlobalAppearance = false;
          const globalInput = configBody.querySelector('[data-setting-id="useGlobalAppearance"]');
          if (globalInput instanceof HTMLInputElement) globalInput.checked = false;
          syncKeystrokesConfigChange(cfg);
          saveSettings();
        };
        advancedBody?.addEventListener("input", updateKeystrokesColorSetting);
        advancedBody?.addEventListener("change", updateKeystrokesColorSetting);
        configBody.appendChild(details);
      }
    }

    configTitleEl.textContent = moduleName;
    configSubEl.textContent = getModuleDescription(moduleName);
    setBindButtonText("Set keybind");
    setCurrentBindText(cfg.keybind || null);

    configBackdrop.classList.remove("hidden");
    configMenu.classList.remove("hidden");
    settingsMenu.classList.add("hidden");
  }

  function openSettings() {
    configBackdrop.classList.remove("hidden");
    settingsMenu.classList.remove("hidden");
    configMenu.classList.add("hidden");
  }

  function collectSettings() {
    try {
      if (upgradeHudState?.container?.isConnected) {
        const pos = readHudPositionFromElement(upgradeHudState.container);
        if (pos) {
          const cfg = getHudModuleConfigObject("Upgrade HUD", { displayTitle: true, showLvlPrefix: false, showUpgradeButton: true, hudSize: 100, hudPosition: null });
          if (cfg && typeof cfg === "object") { cfg.hudPosition = { x: Math.round(pos.x), y: Math.round(pos.y) }; console.log("[HUD Position] Stored before settings save", { moduleName: "Upgrade HUD", hudPosition: { ...cfg.hudPosition } }); }
        }
      }
      if (lavaBuildingHudState?.container?.isConnected) {
        const pos = readHudPositionFromElement(lavaBuildingHudState.container);
        if (pos) {
          const cfg = getHudModuleConfigObject("Building HUD", { displayTitle: true, hudSize: 100, hudPosition: null });
          if (cfg && typeof cfg === "object") { cfg.hudPosition = { x: Math.round(pos.x), y: Math.round(pos.y) }; console.log("[HUD Position] Stored before settings save", { moduleName: "Building HUD", hudPosition: { ...cfg.hudPosition } }); }
        }
      }
      if (abilityHudState?.container?.isConnected) {
        const pos = readHudPositionFromElement(abilityHudState.container);
        if (pos) {
          const cfg = moduleCfg(ABILITY_HUD_MODULE_NAME);
          if (cfg && typeof cfg === "object") { cfg.hudPosition = { x: Math.round(pos.x), y: Math.round(pos.y) }; console.log("[HUD Position] Stored before settings save", { moduleName: ABILITY_HUD_MODULE_NAME, hudPosition: { ...cfg.hudPosition } }); }
        }
      }
      if (keystrokesState?.container?.isConnected) {
        const rect = keystrokesState.container.getBoundingClientRect();
        const cfg = moduleCfg(KEYSTROKES_MODULE_NAME);
        if (cfg && typeof cfg === "object") {
          cfg.x = Math.round(rect.left);
          cfg.y = Math.round(rect.top);
          keystrokesState.config = { ...getKeystrokesConfig(), x: cfg.x, y: cfg.y };
          window.__anrrgmKeystrokesConfig = { ...keystrokesState.config };
        }
      }
    } catch (_) {}
    return {
      toggleKey: CONFIG.toggleKey,
      globalPreset: state.globalPreset,
      searchAutofocus: searchAutofocusInput.checked,
      accent: accentInput.value,
      shellBgStart: shellBgStartInput.value,
      shellBgEnd: shellBgEndInput.value,
      topbarColor: topbarColorInput.value,
      iconColor: iconColorInput.value,
      outlineColor: outlineColorInput.value,
      panelCountText: panelCountTextInput.value,
      panelCountBorder: panelCountBorderInput.value,
      panelCountBg: panelCountBgInput.value,
      border: borderInput.value,
      text: textInput.value,
      opacity: opacityInput.value,
      sliderColor: sliderColorInput.value,
      checkmarkColor: checkmarkColorInput.value,
      selectBg: selectBgInput.value,
      selectText: selectTextInput.value,
      inputBg: inputBgInput.value,
      inputText: inputTextInput.value,
      mutedText: mutedTextInput.value,
      accentSoft: accentSoftInput.value,
      searchText: searchTextInput.value,
      font: fontInput.value,
      headerStart: headerStartInput.value,
      headerEnd: headerEndInput.value,
      headerText: headerTextInput.value,
      moduleDisabledBg: moduleDisabledBgInput.value,
      settingsHeaderStart: settingsHeaderStartInput.value,
      settingsHeaderEnd: settingsHeaderEndInput.value,
      settingsSidebar: settingsSidebarInput.value,
      settingsBody: settingsBodyInput.value,
      settingsText: settingsTextInput.value,
      settingsSubtext: settingsSubtextInput.value,
      settingsCardBorder: settingsCardBorderInput.value,
      settingsCardBg: settingsCardBgInput.value,
      espValueTextColor: espValueTextColorInput.value,
      scale: scaleInput.value,
      radius: radiusInput.value,
      blur: blurInput.value,
      hoverShift: hoverShiftInput.value,
      displayMode: state.displayMode,
      looseInitialized: state.looseInitialized,
      loosePositions: state.loosePositions,
      loosePanelPositions: state.loosePanelPositions,
      collapsedPanels: state.collapsedPanels,
      hiddenCategories: state.hiddenCategories,
      enabledModules: Array.from(state.enabledModules).filter((moduleName) => !moduleCfg(moduleName).hold),
      moduleConfig: Array.from(ensureModuleConfigStore().entries()),
    };
  }

  function setPanelCollapsed(panelName, collapsed) {
    const panel = panelByName.get(panelName);
    if (!panel) return;
    const list = panel.querySelector(".anrrgm-module-list");
    if (!list) return;
    state.collapsedPanels[panelName] = collapsed;
    list.style.display = collapsed ? "none" : "";
    const button = panelCollapseButtons.get(panelName);
    if (button) {
      button.textContent = collapsed ? "▸" : "▾";
      button.title = collapsed ? "Expand category" : "Collapse category";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("collapsed", collapsed);
    }
  }

  function syncCollapseButtons() {
    for (const [panelName, button] of panelCollapseButtons.entries()) {
      const collapsed = !!state.collapsedPanels[panelName];
      button.textContent = collapsed ? "▸" : "▾";
      button.title = collapsed ? "Expand category" : "Collapse category";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("collapsed", collapsed);
    }
  }

  function isPanelHidden(panelName) {
    return !!state.hiddenCategories[panelName];
  }

  function setPanelHidden(panelName, hidden) {
    state.hiddenCategories[panelName] = !!hidden;
    applySearchFilter();

  }

  function clampToViewport(x, y, el) {
    const rect = el.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    return {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }

  function getShellScale() {
    const transform = getComputedStyle(shell).transform;
    if (!transform || transform === "none") return 1;
    const matrix = transform.match(/^matrix\((.+)\)$/);
    if (!matrix) return 1;
    const values = matrix[1].split(",").map((v) => Number(v.trim()));
    if (values.length < 4 || values.some((v) => !Number.isFinite(v))) return 1;
    const [a, b] = values;
    return Math.max(0.01, Math.hypot(a, b));
  }

  function clampLoosePosition(x, y, el, scale, shellRect) {
    const rect = el.getBoundingClientRect();
    const minX = -shellRect.left / scale;
    const minY = -shellRect.top / scale;
    const maxX = (window.innerWidth - shellRect.left - rect.width) / scale;
    const maxY = (window.innerHeight - shellRect.top - rect.height) / scale;
    return {
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    };
  }

  let dragState = null;
  let resizeState = null;
  let hasPositionChanges = false;
  let hasSizeChanges = false;

  const panelDragState = { panelName: null, offsetX: 0, offsetY: 0, shellLeft: 0, shellTop: 0, scale: 1 };

  function normalizeDisplayMode(value) {
    return value === "merged" ? "merged" : "loose";
  }

  function normalizeLoosePoint(value, fallbackX, fallbackY) {
    const x = Number(value?.x);
    const y = Number(value?.y);
    return {
      x: Number.isFinite(x) ? x : fallbackX,
      y: Number.isFinite(y) ? y : fallbackY,
    };
  }

  function getMergedPanelPositionsSnapshot() {
    const snapshot = {};
    shell.classList.remove("loose-mode");
    const shellRect = shell.getBoundingClientRect();
    for (const [name, panel] of panelByName.entries()) {
      const rect = panel.getBoundingClientRect();
      snapshot[name] = {
        x: Math.round(rect.left - shellRect.left),
        y: Math.round(rect.top - shellRect.top),
      };
    }
    return snapshot;
  }

  function setDisplayMode(mode) {
    const nextMode = normalizeDisplayMode(mode);
    const mergedSnapshot = nextMode === "loose" ? getMergedPanelPositionsSnapshot() : null;

    if (nextMode === "loose" && !state.looseInitialized) {
      // Capture while still in merged flow layout so the first loose layout mirrors merged positions.
      state.loosePanelPositions = { ...mergedSnapshot };
      state.looseInitialized = true;
    }

    state.displayMode = nextMode;
    shell.classList.toggle("loose-mode", state.displayMode === "loose");

    for (const btn of displayModeButtons) {
      btn.classList.toggle("active", btn.dataset.displayMode === state.displayMode);
    }

    if (state.displayMode === "loose") {
      shell.style.width = "";
      shell.style.height = "";
      state.mergedRootPosition = {
        left: parseInt(root.style.left || "20", 10),
        top: parseInt(root.style.top || "28", 10),
      };
      root.style.left = "0px";
      root.style.top = "0px";

      const shellRect = shell.getBoundingClientRect();
      const scale = getShellScale();
      state.loosePositions.topbar = normalizeLoosePoint(state.loosePositions?.topbar, 12, 12);
      const clampedTopbar = clampLoosePosition(state.loosePositions.topbar.x, state.loosePositions.topbar.y, topbar, scale, shellRect);
      state.loosePositions.topbar = clampedTopbar;
      topbar.style.left = `${clampedTopbar.x}px`;
      topbar.style.top = `${clampedTopbar.y}px`;

      let panelIndex = 0;
      for (const [name, panel] of panelByName.entries()) {
        const existingRect = panel.getBoundingClientRect();
        const snapshotPos = mergedSnapshot?.[name];
        const hasRenderableSize = existingRect.width > 0 && existingRect.height > 0;
        const safeSnapshotPos = hasRenderableSize ? snapshotPos : null;
        const safeFallbackPos = hasRenderableSize
          ? {
            x: Math.round((existingRect.left - shellRect.left) / Math.max(scale, 0.001)),
            y: Math.round((existingRect.top - shellRect.top) / Math.max(scale, 0.001)),
          }
          : { x: 16 + panelIndex * 22, y: 68 + panelIndex * 18 };
        const pos = state.loosePanelPositions[name]
          || safeSnapshotPos
          || safeFallbackPos;
        const clamped = clampLoosePosition(pos.x, pos.y, panel, scale, shellRect);
        state.loosePanelPositions[name] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
        panelIndex += 1;
      }
    } else {
      root.style.left = `${state.mergedRootPosition.left}px`;
      root.style.top = `${state.mergedRootPosition.top}px`;
      topbar.style.left = "";
      topbar.style.top = "";
      for (const panel of panelByName.values()) {
        panel.style.left = "";
        panel.style.top = "";
      }
      shell.style.width = `${state.shellWidth}px`;
      shell.style.height = `${state.shellHeight}px`;
    }
  }

  function applyPreset(presetName) {
    state.globalPreset = normalizePopupPresetName(presetName || "default");
    const popupCfg = getModuleConfigSafe("Answer Popup");
    popupCfg.preset = state.globalPreset;
    applyAnswerPopupPreset(popupCfg, state.globalPreset);
    const preset = (() => {
      if (state.globalPreset === "green") {
        return {
          accent: "#2dff75", shellStart: "#2dff75", shellEnd: "#03130a", topbar: "#35d96d", border: "#5dff9a",
          outline: "#37d878", text: "#d7ffe6", muted: "#88b79b", soft: "#a8ffd0", search: "#e6fff0", icon: "#d7ffe9",
          panelText: "#d9ffe8", panelBorder: "#5fff99", panelBg: "#04110a", slider: "#2dff75", checkmark: "#2dff75",
          selectBg: "#111e16", selectText: "#d7ffe6",
          headerStart: "#2dff75", headerEnd: "#0f2f1b", headerText: "#f0fff4", moduleDisabledBg: "#000000",
          settingsText: "#d7ffe6", settingsSubtext: "#a7cfb7", settingsSidebar: "#102016", settingsBody: "#0d1510",
          settingsCardBorder: "#79d6a0", settingsCardBg: "#12301f",
          settingsHeaderStart: "#2dff75", settingsHeaderEnd: "#0f2f1b", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      if (state.globalPreset === "ice") {
        return {
          accent: "#6cd8ff", shellStart: "#6cd8ff", shellEnd: "#07131a", topbar: "#58bff1", border: "#8ae4ff",
          outline: "#6fbce8", text: "#d7edff", muted: "#8ea7bd", soft: "#b8e5ff", search: "#e7f5ff", icon: "#dff3ff",
          panelText: "#e1f4ff", panelBorder: "#8fd7ff", panelBg: "#071019", slider: "#7bdfff", checkmark: "#7bdfff",
          selectBg: "#0c1c26", selectText: "#d7edff",
          headerStart: "#6cd8ff", headerEnd: "#133042", headerText: "#f4fbff", moduleDisabledBg: "#000000",
          settingsText: "#d7edff", settingsSubtext: "#9db4c6", settingsSidebar: "#10202c", settingsBody: "#0e141a",
          settingsCardBorder: "#90cae8", settingsCardBg: "#173247",
          settingsHeaderStart: "#6cd8ff", settingsHeaderEnd: "#133042", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      if (state.globalPreset === "midnight") {
        return {
          accent: "#9b5cff", shellStart: "#6f2dff", shellEnd: "#080314", topbar: "#7d3cff", border: "#a777ff",
          outline: "#9b5cff", text: "#e7ddff", muted: "#aa92d4", soft: "#cdb6ff", search: "#f2eaff", icon: "#decfff",
          panelText: "#efe6ff", panelBorder: "#a777ff", panelBg: "#0f0820", slider: "#b084ff", checkmark: "#b084ff",
          selectBg: "#17102a", selectText: "#f2eaff",
          headerStart: "#9b5cff", headerEnd: "#220d40", headerText: "#ffffff", moduleDisabledBg: "#000000",
          settingsText: "#f2eaff", settingsSubtext: "#bca8df", settingsSidebar: "#17102b", settingsBody: "#10091d",
          settingsCardBorder: "#9f7ad9", settingsCardBg: "#24133f",
          settingsHeaderStart: "#9b5cff", settingsHeaderEnd: "#220d40", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      if (state.globalPreset === "grayscale") {
        return {
          accent: "#d3d3d3", shellStart: "#7a7a7a", shellEnd: "#0a0a0a", topbar: "#8d8d8d", border: "#b1b1b1",
          outline: "#9a9a9a", text: "#dddddd", muted: "#9a9a9a", soft: "#c9c9c9", search: "#f1f1f1", icon: "#f5f5f5",
          panelText: "#efefef", panelBorder: "#a0a0a0", panelBg: "#0f0f0f", slider: "#c4c4c4", checkmark: "#d0d0d0",
          selectBg: "#1b1b1b", selectText: "#efefef",
          headerStart: "#8f8f8f", headerEnd: "#1d1d1d", headerText: "#ffffff", moduleDisabledBg: "#000000",
          settingsText: "#efefef", settingsSubtext: "#b2b2b2", settingsSidebar: "#202020", settingsBody: "#181818",
          settingsCardBorder: "#b7b7b7", settingsCardBg: "#313131",
          settingsHeaderStart: "#8f8f8f", settingsHeaderEnd: "#1d1d1d", espValueTextColor: "#ffffff",
          font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        };
      }
      // Default (red)
      return {
        accent: "#ff3d3d", shellStart: "#ff3d3d", shellEnd: "#000000", topbar: "#ff4a4a", border: "#ff6f6f",
        outline: "#ff5b5b", text: "#d6d6df", muted: "#9b9bab", soft: "#ffbdbd", search: "#ffe6e6", icon: "#ffdada",
        panelText: "#ffd9d9", panelBorder: "#ff6464", panelBg: "#1a1a1e", slider: "#ff6b6b", checkmark: "#ff6b6b",
        selectBg: "#17171f", selectText: "#ffe5e5",
        headerStart: "#ff4a4a", headerEnd: "#3c1212", headerText: "#ffffff", moduleDisabledBg: "#000000",
        settingsText: "#ffe5e5", settingsSubtext: "#c2c2ce", settingsSidebar: "#181820", settingsBody: "#121216",
        settingsCardBorder: "#ffffff", settingsCardBg: "#ffffff",
        settingsHeaderStart: "#ff3d3d", settingsHeaderEnd: "#2d0c0c", espValueTextColor: "#ffffff",
        font: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      };
    })();

    accentInput.value = preset.accent;
    shellBgStartInput.value = preset.shellStart;
    shellBgEndInput.value = preset.shellEnd;
    topbarColorInput.value = preset.topbar;
    borderInput.value = preset.border;
    outlineColorInput.value = preset.outline;
    textInput.value = preset.text;
    mutedTextInput.value = preset.muted;
    accentSoftInput.value = preset.soft;
    searchTextInput.value = preset.search;
    fontInput.value = preset.font || "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    iconColorInput.value = preset.icon;
    panelCountTextInput.value = preset.panelText;
    panelCountBorderInput.value = preset.panelBorder;
    panelCountBgInput.value = preset.panelBg;
    sliderColorInput.value = preset.slider;
    checkmarkColorInput.value = preset.checkmark;
    selectBgInput.value = preset.selectBg;
    selectTextInput.value = preset.selectText;
    inputBgInput.value = preset.selectBg;
    inputTextInput.value = preset.selectText;
    headerStartInput.value = preset.headerStart;
    headerEndInput.value = preset.headerEnd;
    headerTextInput.value = preset.headerText;
    moduleDisabledBgInput.value = preset.moduleDisabledBg || "#000000";
    settingsHeaderStartInput.value = preset.settingsHeaderStart;
    settingsHeaderEndInput.value = preset.settingsHeaderEnd;
    settingsSidebarInput.value = preset.settingsSidebar;
    settingsBodyInput.value = preset.settingsBody;
    settingsTextInput.value = preset.settingsText;
    settingsSubtextInput.value = preset.settingsSubtext;
    settingsCardBorderInput.value = preset.settingsCardBorder;
    settingsCardBgInput.value = preset.settingsCardBg;
    espValueTextColorInput.value = preset.espValueTextColor;
    applyAppearance();
    refreshVisibleAnswerPopup();
    saveSettings();
  }

  function applyAppearance() {
    const normalizeHex = (value, fallback) => {
      const normalized = String(value || "").trim();
      return /^#([0-9a-fA-F]{6})$/.test(normalized) ? normalized.toLowerCase() : fallback;
    };
    const clampNumber = (value, min, max, fallback) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    };
    const toRgba = (hex, alpha) => {
      const h = hex.replace("#", "");
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const darken = (hex, factor) => {
      const h = hex.replace("#", "");
      const r = Math.max(0, Math.floor(parseInt(h.slice(0, 2), 16) * factor));
      const g = Math.max(0, Math.floor(parseInt(h.slice(2, 4), 16) * factor));
      const b = Math.max(0, Math.floor(parseInt(h.slice(4, 6), 16) * factor));
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    };

    const shellBgStart = normalizeHex(shellBgStartInput.value, "#ff3d3d");
    const shellBgEnd = normalizeHex(shellBgEndInput.value, "#000000");
    const topbarColor = normalizeHex(topbarColorInput.value, "#ff4a4a");
    const iconColor = normalizeHex(iconColorInput.value, "#ffdada");
    const outlineColor = normalizeHex(outlineColorInput.value, "#ff5b5b");
    const panelCountText = normalizeHex(panelCountTextInput.value, "#ffd9d9");
    const panelCountBorder = normalizeHex(panelCountBorderInput.value, "#ff6464");
    const panelCountBg = normalizeHex(panelCountBgInput.value, "#1a1a1e");
    const border = normalizeHex(borderInput.value, "#ff6f6f");
    const text = normalizeHex(textInput.value, "#d6d6df");
    const opacity = clampNumber(opacityInput.value, 10, 100, 45) / 100;
    const sliderColor = normalizeHex(sliderColorInput.value, "#ff6b6b");
    const checkmarkColor = normalizeHex(checkmarkColorInput.value, "#ff6b6b");
    const selectBg = normalizeHex(selectBgInput.value, "#17171f");
    const selectText = normalizeHex(selectTextInput.value, "#ffe5e5");
    const inputBg = normalizeHex(inputBgInput.value, "#17171f");
    const inputText = normalizeHex(inputTextInput.value, "#ffe5e5");
    const mutedText = normalizeHex(mutedTextInput.value, "#9b9bab");
    const accentSoft = normalizeHex(accentSoftInput.value, "#ffbdbd");
    const searchText = normalizeHex(searchTextInput.value, "#ffe6e6");
    const font = fontInput.value;
    const headerStart = normalizeHex(headerStartInput.value, "#ff4a4a");
    const headerEnd = normalizeHex(headerEndInput.value, "#3c1212");
    const headerText = normalizeHex(headerTextInput.value, "#ffffff");
    const moduleDisabledBg = normalizeHex(moduleDisabledBgInput.value, "#000000");
    const settingsHeaderStart = normalizeHex(settingsHeaderStartInput.value, "#ff3d3d");
    const settingsHeaderEnd = normalizeHex(settingsHeaderEndInput.value, "#2d0c0c");
    const settingsSidebar = normalizeHex(settingsSidebarInput.value, "#181820");
    const settingsBody = normalizeHex(settingsBodyInput.value, "#121216");
    const settingsText = normalizeHex(settingsTextInput.value, "#ffe5e5");
    const settingsSubtext = normalizeHex(settingsSubtextInput.value, "#c2c2ce");
    const settingsCardBorder = normalizeHex(settingsCardBorderInput.value, "#ffffff");
    const settingsCardBg = normalizeHex(settingsCardBgInput.value, "#ffffff");
    const espValueTextColor = normalizeHex(espValueTextColorInput.value, "#ffffff");
    const scale = clampNumber(scaleInput.value, 80, 130, 100) / 100;
    const radius = clampNumber(radiusInput.value, 8, 22, 14);
    const blur = clampNumber(blurInput.value, 0, 24, 10);
    const hoverShift = clampNumber(hoverShiftInput.value, 0, 8, 2);
    const themeTargets = [root.style, configBackdrop.style];
    const setThemeVar = (name, value) => {
      for (const target of themeTargets) target.setProperty(name, value);
    };
    setThemeVar("--arr-border", `${border}99`);
    setThemeVar("--arr-text", text);
    setThemeVar("--arr-font", font);
    setThemeVar("--arr-muted", mutedText);
    setThemeVar("--arr-accent-soft", accentSoft);
    setThemeVar("--arr-search-text", searchText);
    setThemeVar("--arr-topbar-bg-start", toRgba(topbarColor, 0.22));
    setThemeVar("--arr-topbar-bg-end", toRgba(darken(topbarColor, 0.22), 0.9));
    setThemeVar("--arr-module-disabled-bg", toRgba(moduleDisabledBg, 0.72));
    setThemeVar("--arr-module-hover-bg", toRgba(topbarColor, 0.28));
    setThemeVar("--arr-module-hover-border", toRgba(topbarColor, 0.4));
    setThemeVar("--arr-module-active-start", toRgba(headerStart, 0.35));
    setThemeVar("--arr-module-active-end", toRgba(headerEnd, 0.82));
    setThemeVar("--arr-module-active-border", toRgba(headerStart, 0.55));
    setThemeVar("--arr-icon-color", iconColor);
    setThemeVar("--arr-outline-color", `${outlineColor}cc`);
    setThemeVar("--arr-panel-count-text", panelCountText);
    setThemeVar("--arr-panel-count-border", toRgba(panelCountBorder, 0.45));
    setThemeVar("--arr-panel-count-bg", toRgba(panelCountBg, 0.6));
    setThemeVar("--arr-header-bg-start", toRgba(headerStart, 0.24));
    setThemeVar("--arr-header-bg-end", toRgba(headerEnd, 0.92));
    setThemeVar("--arr-header-text", headerText);
    setThemeVar("--arr-settings-header-start", toRgba(settingsHeaderStart, 0.3));
    setThemeVar("--arr-settings-header-end", toRgba(settingsHeaderEnd, 0.95));
    setThemeVar("--arr-settings-sidebar-bg", toRgba(settingsSidebar, 0.22));
    setThemeVar("--arr-settings-body-bg", `linear-gradient(180deg, ${toRgba(settingsBody, 0.97)}, rgba(8, 8, 10, 0.97))`);
    setThemeVar("--arr-settings-text", settingsText);
    setThemeVar("--arr-settings-subtext", settingsSubtext);
    setThemeVar("--arr-settings-card-border", toRgba(settingsCardBorder, 0.18));
    setThemeVar("--arr-settings-card-bg", toRgba(settingsCardBg, 0.05));
    setThemeVar("--arr-slider-color", sliderColor);
    setThemeVar("--arr-checkmark-color", checkmarkColor);
    setThemeVar("--arr-select-bg", toRgba(selectBg, 0.9));
    setThemeVar("--arr-select-text", selectText);
    setThemeVar("--arr-input-bg", toRgba(inputBg, 0.9));
    setThemeVar("--arr-input-text", inputText);
    window.__anrrgmEspValueTextColor = espValueTextColor;
    window.__anrrgmEspConfig = { ...getEspRenderConfig(), valueTextColor: espValueTextColor, font: font };
    setThemeVar("--arr-radius-xl", `${radius}px`);
    setThemeVar("--arr-radius-lg", `${Math.max(4, radius - 2)}px`);
    setThemeVar("--arr-radius-md", `${Math.max(3, radius - 4)}px`);
    setThemeVar("--arr-hover-shift", `${hoverShift}px`);
    shell.style.transform = `scale(${scale.toFixed(2)})`;
    shell.style.transformOrigin = "top left";
    shell.style.background = `linear-gradient(150deg, ${toRgba(shellBgStart, 0.22)}, ${toRgba(shellBgEnd, opacity.toFixed(2))})`;
    setThemeVar("--arr-shell-blur", `${blur}px`);
    shell.style.backdropFilter = `blur(var(--arr-shell-blur)) saturate(115%)`;

    // FIX: derive button accent background from outlineColor so buttons always match the theme
    setThemeVar("--arr-btn-bg", toRgba(outlineColor, 0.12));
    setThemeVar("--arr-btn-hover-bg", toRgba(outlineColor, 0.2));
    window.__anrrgmAppearanceVars = {};
    for (const name of [
      "--arr-module-disabled-bg",
      "--arr-module-hover-bg",
      "--arr-module-hover-border",
      "--arr-module-active-start",
      "--arr-module-active-end",
      "--arr-module-active-border",
      "--arr-text",
      "--arr-header-bg-start",
      "--arr-header-bg-end",
      "--arr-outline-color",
      "--arr-slider-color",
      "--arr-font",
      "--arr-radius-md",
      "--arr-radius-lg",
    ]) {
      window.__anrrgmAppearanceVars[name] = root.style.getPropertyValue(name);
    }
    if (keystrokesState.enabled) {
      renderKeystrokesOverlay();
      setTimeout(scheduleKeystrokesRender, 0);
    }

    if (state.displayMode === "loose") {
      const shellRect = shell.getBoundingClientRect();
      const looseScale = getShellScale();
      for (const [name, panel] of panelByName.entries()) {
        const existingRect = panel.getBoundingClientRect();
        const fallback = {
          x: Math.round((existingRect.left - shellRect.left) / Math.max(looseScale, 0.001)),
          y: Math.round((existingRect.top - shellRect.top) / Math.max(looseScale, 0.001)),
        };
        const current = state.loosePanelPositions[name] || fallback;
        const clamped = clampLoosePosition(current.x, current.y, panel, looseScale, shellRect);
        state.loosePanelPositions[name] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
        hasPositionChanges = true;
      }
    }

    const stylesCfg = getStylesConfigStore();
    if (stylesCfg?.useGlobalTheme && isQuestionStylesEnabled()) refreshQuestionStylesAfterConfigChange();
  }

  function applySearchFilter() {
    const query = state.searchQuery.trim().toLowerCase();

    for (const entry of state.moduleEntries) {
      const visibleByQuery = !query || entry.name.toLowerCase().includes(query);
      entry.item.style.display = visibleByQuery ? "" : "none";
    }

    for (const [panel, meta] of state.modulePanels.entries()) {
      const panelName = panel.dataset.panelName || "";
      if (isPanelHidden(panelName)) {
        panel.style.display = "none";
        continue;
      }
      let visibleCount = 0;
      for (const moduleName of meta.modules) {
        const item = state.moduleItems.get(moduleName);
        if (item && item.style.display !== "none") visibleCount += 1;
      }

      panel.style.display = visibleCount > 0 ? "" : "none";
    }
  }

  function buildPanel(name, modules) {
    const panel = document.createElement("section");
    panel.className = "anrrgm-panel";
    panel.dataset.panelName = name;

    const header = document.createElement("header");
    header.className = "anrrgm-panel-header";

    const title = document.createElement("span");
    title.textContent = name;

    const collapseButton = document.createElement("span");
    collapseButton.className = "anrrgm-panel-collapse-btn";
    collapseButton.textContent = "▾";
    collapseButton.title = "Collapse category";
    collapseButton.setAttribute("role", "button");
    collapseButton.setAttribute("tabindex", "0");
    collapseButton.setAttribute("aria-label", "Collapse category");
    const toggleCollapsed = (event) => {
      event.stopPropagation();
      const nextCollapsed = !state.collapsedPanels[name];
      setPanelCollapsed(name, nextCollapsed);
      saveSettings();
    };
    collapseButton.addEventListener("click", toggleCollapsed);
    collapseButton.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleCollapsed(event);
    });

    header.appendChild(title);
    header.appendChild(collapseButton);

    const list = document.createElement("ul");
    list.className = "anrrgm-module-list";

    const moduleNames = [];
    for (const moduleDef of modules) {
      const moduleName = typeof moduleDef === "string" ? moduleDef : moduleDef?.name;
      if (!moduleName) continue;
      if (state.moduleItems.has(moduleName)) continue;
      moduleNames.push(moduleName);
      const item = document.createElement("li");
      item.className = "anrrgm-module";
      item.innerHTML = `<span>${moduleName}</span><span class="anrrgm-bind-label"></span>`;

      state.moduleItems.set(moduleName, item);
      state.moduleEntries.push({ name: moduleName, item, panel });

      const behavior = MODULE_BEHAVIORS[moduleName];
      const moduleInstance = new Module(moduleName, {
        onEnable: () => {
          console.log(`[AnRRgm] ${moduleName} enable requested`);
          try {
            if (behavior?.onEnable) behavior.onEnable();
            console.log(`[AnRRgm] ${moduleName} enabled`);
          } catch (error) {
            console.error(`[AnRRgm] ${moduleName} failed to enable`, error);
          }
        },
        onDisable: () => {
          console.log(`[AnRRgm] ${moduleName} disable requested`);
          try {
            if (behavior?.onDisable) behavior.onDisable();
            console.log(`[AnRRgm] ${moduleName} disabled`);
          } catch (error) {
            console.error(`[AnRRgm] ${moduleName} failed to disable`, error);
          }
        },
      });
      state.modules.set(moduleName, moduleInstance);

      moduleCfg(moduleName);
      setBindLabel(item, moduleName);

      item.addEventListener("click", () => {
        const cfg = moduleCfg(moduleName);
        if (cfg.hold) return;
        toggleModule(moduleName);
      });

      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openConfig(moduleName);
      });

      list.appendChild(item);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    panelByName.set(name, panel);
    panelCollapseButtons.set(name, collapseButton);
    state.modulePanels.set(panel, { modules: moduleNames });
    return panel;
  }

  settingsMenuKeyBtn.addEventListener("click", () => {
    state.listeningForMenuBind = true;
    settingsMenuKeyBtn.textContent = "Press key...";
    searchInput.blur();
  });

  settingsMenuKeyResetBtn.addEventListener("click", () => {
    CONFIG.toggleKey = CONFIG.defaultToggleKey;
    settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
    setFooterText();
    state.listeningForMenuBind = false;
    saveSettings();
  });

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset || "default"));
  });

  settingsBtn.addEventListener("click", () => {
    openSettings();
  });

  settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of settingsTabs) t.classList.toggle("active", t === tab);
      for (const pane of settingsPanes) pane.classList.toggle("hidden", pane.dataset.pane !== target);
    });
  });

  searchInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === CONFIG.toggleKey) {
      event.preventDefault();
      setVisible(false);
    }
  });

  const applySearchFilterDebounced = debounce(applySearchFilter, 80);
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    applySearchFilterDebounced();
  });

  accentInput.addEventListener("input", applyAppearance);
  shellBgStartInput.addEventListener("input", applyAppearance);
  shellBgEndInput.addEventListener("input", applyAppearance);
  topbarColorInput.addEventListener("input", applyAppearance);
  iconColorInput.addEventListener("input", applyAppearance);
  outlineColorInput.addEventListener("input", applyAppearance);
  panelCountTextInput.addEventListener("input", applyAppearance);
  panelCountBorderInput.addEventListener("input", applyAppearance);
  panelCountBgInput.addEventListener("input", applyAppearance);
  borderInput.addEventListener("input", applyAppearance);
  textInput.addEventListener("input", applyAppearance);
  opacityInput.addEventListener("input", applyAppearance);
  sliderColorInput.addEventListener("input", applyAppearance);
  checkmarkColorInput.addEventListener("input", applyAppearance);
  mutedTextInput.addEventListener("input", applyAppearance);
  accentSoftInput.addEventListener("input", applyAppearance);
  searchTextInput.addEventListener("input", applyAppearance);
  fontInput.addEventListener("input", applyAppearance);
  fontInput.addEventListener("change", applyAppearance);
  headerStartInput.addEventListener("input", applyAppearance);
  headerEndInput.addEventListener("input", applyAppearance);
  headerTextInput.addEventListener("input", applyAppearance);
  moduleDisabledBgInput.addEventListener("input", applyAppearance);
  settingsHeaderStartInput.addEventListener("input", applyAppearance);
  settingsHeaderEndInput.addEventListener("input", applyAppearance);
  settingsSidebarInput.addEventListener("input", applyAppearance);
  settingsBodyInput.addEventListener("input", applyAppearance);
  settingsTextInput.addEventListener("input", applyAppearance);
  settingsSubtextInput.addEventListener("input", applyAppearance);
  settingsCardBorderInput.addEventListener("input", applyAppearance);
  settingsCardBgInput.addEventListener("input", applyAppearance);
  selectBgInput.addEventListener("input", applyAppearance);
  selectTextInput.addEventListener("input", applyAppearance);
  inputBgInput.addEventListener("input", applyAppearance);
  inputTextInput.addEventListener("input", applyAppearance);
  espValueTextColorInput.addEventListener("input", applyAppearance);
  scaleInput.addEventListener("input", applyAppearance);
  radiusInput.addEventListener("input", applyAppearance);
  blurInput.addEventListener("input", applyAppearance);
  hoverShiftInput.addEventListener("input", applyAppearance);
  displayModeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setDisplayMode(btn.dataset.displayMode || "merged");
      saveSettings();
    });
  });
  searchAutofocusInput.addEventListener("change", () => {
    state.searchAutofocus = searchAutofocusInput.checked;
  });
  function resetModuleTabPositions() {
    state.looseInitialized = false;
    state.loosePositions = { topbar: { x: 12, y: 12 } };
    state.loosePanelPositions = {};
    setDisplayMode(state.displayMode);
  }

  function resetAppearanceSettings() {
    accentInput.value = "#ff3d3d";
    shellBgStartInput.value = "#ff3d3d";
    shellBgEndInput.value = "#000000";
    topbarColorInput.value = "#ff4a4a";
    iconColorInput.value = "#ffdada";
    outlineColorInput.value = "#ff5b5b";
    panelCountTextInput.value = "#ffd9d9";
    panelCountBorderInput.value = "#ff6464";
    panelCountBgInput.value = "#1a1a1e";
    borderInput.value = "#ff6f6f";
    textInput.value = "#d6d6df";
    opacityInput.value = "45";
    sliderColorInput.value = "#ff6b6b";
    checkmarkColorInput.value = "#ff6b6b";
    selectBgInput.value = "#17171f";
    selectTextInput.value = "#ffe5e5";
    inputBgInput.value = "#17171f";
    inputTextInput.value = "#ffe5e5";
    mutedTextInput.value = "#9b9bab";
    accentSoftInput.value = "#ffbdbd";
    searchTextInput.value = "#ffe6e6";
    fontInput.value = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    headerStartInput.value = "#ff4a4a";
    headerEndInput.value = "#3c1212";
    headerTextInput.value = "#ffffff";
    moduleDisabledBgInput.value = "#000000";
    settingsHeaderStartInput.value = "#ff3d3d";
    settingsHeaderEndInput.value = "#2d0c0c";
    settingsSidebarInput.value = "#181820";
    settingsBodyInput.value = "#121216";
    settingsTextInput.value = "#ffe5e5";
    settingsSubtextInput.value = "#c2c2ce";
    settingsCardBorderInput.value = "#ffffff";
    settingsCardBgInput.value = "#ffffff";
    espValueTextColorInput.value = "#ffffff";
    searchAutofocusInput.checked = true;
    state.searchAutofocus = true;
    state.globalPreset = "default";
    scaleInput.value = "100";
    radiusInput.value = "14";
    blurInput.value = "10";
    hoverShiftInput.value = "2";
    state.collapsedPanels = {};
    for (const panelName of panelByName.keys()) {
      setPanelCollapsed(panelName, false);
    }
    syncCollapseButtons();
    setDisplayMode("loose");
    const themeTargets = [root.style, configBackdrop.style];
    const removeThemeVar = (name) => {
      for (const target of themeTargets) target.removeProperty(name);
    };
    removeThemeVar("--arr-border");
    removeThemeVar("--arr-text");
    removeThemeVar("--arr-font");
    removeThemeVar("--arr-muted");
    removeThemeVar("--arr-accent-soft");
    removeThemeVar("--arr-search-text");
    removeThemeVar("--arr-topbar-bg-start");
    removeThemeVar("--arr-topbar-bg-end");
    removeThemeVar("--arr-module-disabled-bg");
    removeThemeVar("--arr-module-hover-bg");
    removeThemeVar("--arr-module-hover-border");
    removeThemeVar("--arr-module-active-start");
    removeThemeVar("--arr-module-active-end");
    removeThemeVar("--arr-module-active-border");
    removeThemeVar("--arr-icon-color");
    removeThemeVar("--arr-outline-color");
    removeThemeVar("--arr-panel-count-text");
    removeThemeVar("--arr-panel-count-border");
    removeThemeVar("--arr-panel-count-bg");
    removeThemeVar("--arr-header-bg-start");
    removeThemeVar("--arr-header-bg-end");
    removeThemeVar("--arr-header-text");
    removeThemeVar("--arr-settings-header-start");
    removeThemeVar("--arr-settings-header-end");
    removeThemeVar("--arr-settings-sidebar-bg");
    removeThemeVar("--arr-settings-body-bg");
    removeThemeVar("--arr-settings-text");
    removeThemeVar("--arr-settings-subtext");
    removeThemeVar("--arr-settings-card-border");
    removeThemeVar("--arr-settings-card-bg");
    removeThemeVar("--arr-slider-color");
    removeThemeVar("--arr-checkmark-color");
    removeThemeVar("--arr-select-bg");
    removeThemeVar("--arr-select-text");
    removeThemeVar("--arr-radius-xl");
    removeThemeVar("--arr-radius-lg");
    removeThemeVar("--arr-radius-md");
    removeThemeVar("--arr-hover-shift");
    removeThemeVar("--arr-shell-blur");
    removeThemeVar("--arr-btn-bg");
    removeThemeVar("--arr-btn-hover-bg");
    shell.style.background = "";
    shell.style.transform = "";
    shell.style.backdropFilter = "";
  }

  settingsResetPositionsBtn.addEventListener("click", () => {
    resetModuleTabPositions();
    saveSettings();
  });

  settingsResetBtn.addEventListener("click", () => {
    resetAppearanceSettings();
    resetModuleTabPositions();
    saveSettings();
  });

  settingsResetAllBtn.addEventListener("click", () => {
    resetAppearanceSettings();
    resetModuleTabPositions();
    state.hiddenCategories = {};
    state.globalPreset = "default";
    state.enabledModules = new Set();
    for (const [moduleName, moduleInstance] of state.modules.entries()) {
      if (!moduleInstance?.enabled) continue;
      try { moduleInstance.disable(); } catch (_) {}
      const item = state.moduleItems.get(moduleName);
      item?.classList.remove("active");
    }
    state.moduleConfig = new Map();
    for (const item of state.moduleItems.values()) {
      const moduleName = item.dataset.module;
      if (!moduleName) continue;
      setBindLabel(item, moduleName);
    }
    setCurrentBindText(null);
    state.listeningForBind = null;
    setBindButtonText("Set keybind");
    applySearchFilter();
    saveSettings();
    try { closeConfig(); } catch (_) {}
  });

  function saveSettings(showFeedback = false) {
    try {
      const payload = collectSettings();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      if (showFeedback) {
        settingsSaveBtn.textContent = "Saved";
        setTimeout(() => {
          settingsSaveBtn.textContent = "Save";
        }, 850);
      }
    } catch (error) {
      console.error(error);
      if (showFeedback) {
        settingsSaveBtn.textContent = "Save failed";
        setTimeout(() => {
          settingsSaveBtn.textContent = "Save";
        }, 1200);
      }
    }
  }

  settingsSaveBtn.addEventListener("click", () => {
    saveSettings(true);
  });

  settingsCloseBtn.addEventListener("click", () => {
    closeConfig();
  });
  configResetBtn?.addEventListener("click", () => {
    if (!openConfigModule) return;
    const moduleName = openConfigModule;
    resetModuleConfig(moduleName);
    if (moduleName === ABILITY_HUD_MODULE_NAME) {
      applyAbilityHudLiveConfig({ cfg: moduleCfg(moduleName) });
      requestAbilityHudRender();
    } else if (moduleName === "Upgrade HUD") {
      hardRefreshUpgradeHud(moduleCfg(moduleName));
    } else if (moduleName === "Building HUD") {
      hardRefreshLavaBuildingHud(moduleCfg(moduleName));
    }
    openConfig(moduleName);
  });
  configCloseBtn.addEventListener("click", () => closeConfig());
  settingsTopCloseBtn.addEventListener("click", () => closeConfig());

  const generalPanels = document.createElement("div");
  generalPanels.className = "anrrgm-panels";
  for (const generalGroup of MENU_LAYOUT.general.groups) {
    generalPanels.appendChild(buildPanel(generalGroup.name, generalGroup.modules));
  }
  generalSection.appendChild(generalPanels);

  const gamemodePanels = document.createElement("div");
  gamemodePanels.className = "anrrgm-panels";
  for (const gm of MENU_LAYOUT.gamemodeSpecific.groups) {
    gamemodePanels.appendChild(buildPanel(gm.name, gm.modules));
  }
  gamemodeSection.appendChild(gamemodePanels);

  for (const [panelName] of panelByName.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "anrrgm-collapse-btn";
    btn.textContent = panelName;
    btn.addEventListener("click", () => {
      const nextCollapsed = !state.collapsedPanels[panelName];
      setPanelCollapsed(panelName, nextCollapsed);
      btn.classList.toggle("inactive", nextCollapsed);
    });
    collapseRow.appendChild(btn);
  }

  function renderHiddenCategorySettings() {
    if (!hiddenCategoriesList) return;
    hiddenCategoriesList.innerHTML = "";
    for (const panelName of panelByName.keys()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "anrrgm-hidden-category-btn";
      btn.dataset.panelName = panelName;
      btn.textContent = panelName;
      btn.classList.toggle("is-hidden", isPanelHidden(panelName));
      btn.title = isPanelHidden(panelName) ? "Currently hidden. Click to show." : "Currently visible. Click to hide.";
      btn.addEventListener("click", () => {
        const nextHidden = !isPanelHidden(panelName);
        setPanelHidden(panelName, nextHidden);
        btn.classList.toggle("is-hidden", nextHidden);
        btn.title = nextHidden ? "Currently hidden. Click to show." : "Currently visible. Click to hide.";
        saveSettings();
      });
      hiddenCategoriesList.appendChild(btn);
    }
  }

  renderHiddenCategorySettings();

  shell.appendChild(topbar);
  shell.appendChild(generalSection);
  shell.appendChild(gamemodeSection);
  shell.appendChild(footer);
  shell.appendChild(resizeHandle);

  root.appendChild(shell);

  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.appendChild(configBackdrop);

  let pendingEnabledModules = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        if (saved.toggleKey) CONFIG.toggleKey = saved.toggleKey;
        if (typeof saved.globalPreset === "string") state.globalPreset = normalizePopupPresetName(saved.globalPreset);
        if (typeof saved.searchAutofocus === "boolean") {
          state.searchAutofocus = saved.searchAutofocus;
          searchAutofocusInput.checked = saved.searchAutofocus;
        }
        const assign = (input, key) => {
          if (saved[key] !== undefined && input) input.value = String(saved[key]);
        };
        assign(accentInput, "accent");
        assign(shellBgStartInput, "shellBgStart");
        assign(shellBgEndInput, "shellBgEnd");
        assign(topbarColorInput, "topbarColor");
        assign(iconColorInput, "iconColor");
        assign(outlineColorInput, "outlineColor");
        assign(panelCountTextInput, "panelCountText");
        assign(panelCountBorderInput, "panelCountBorder");
        assign(panelCountBgInput, "panelCountBg");
        assign(borderInput, "border");
        assign(textInput, "text");
        assign(opacityInput, "opacity");
        assign(sliderColorInput, "sliderColor");
        assign(checkmarkColorInput, "checkmarkColor");
        assign(selectBgInput, "selectBg");
        assign(selectTextInput, "selectText");
        assign(inputBgInput, "inputBg");
        assign(inputTextInput, "inputText");
        assign(mutedTextInput, "mutedText");
        assign(accentSoftInput, "accentSoft");
        assign(searchTextInput, "searchText");
        assign(fontInput, "font");
        assign(headerStartInput, "headerStart");
        assign(headerEndInput, "headerEnd");
        assign(headerTextInput, "headerText");
        assign(moduleDisabledBgInput, "moduleDisabledBg");
        assign(settingsHeaderStartInput, "settingsHeaderStart");
        assign(settingsHeaderEndInput, "settingsHeaderEnd");
        assign(settingsSidebarInput, "settingsSidebar");
        assign(settingsBodyInput, "settingsBody");
        assign(settingsTextInput, "settingsText");
        assign(settingsSubtextInput, "settingsSubtext");
        assign(settingsCardBorderInput, "settingsCardBorder");
        assign(settingsCardBgInput, "settingsCardBg");
        assign(espValueTextColorInput, "espValueTextColor");
        assign(scaleInput, "scale");
        assign(radiusInput, "radius");
        assign(blurInput, "blur");
        assign(hoverShiftInput, "hoverShift");
        state.displayMode = normalizeDisplayMode(saved.displayMode);
        if (typeof saved.looseInitialized === "boolean") state.looseInitialized = saved.looseInitialized;
        if (saved.loosePositions && typeof saved.loosePositions === "object") {
          state.loosePositions = {
            topbar: normalizeLoosePoint(saved.loosePositions.topbar, state.loosePositions.topbar.x, state.loosePositions.topbar.y),
          };
        }
        if (saved.loosePanelPositions && typeof saved.loosePanelPositions === "object") {
          const normalizedPanelPositions = {};
          for (const [panelName, panelPos] of Object.entries(saved.loosePanelPositions)) {
            normalizedPanelPositions[panelName] = normalizeLoosePoint(panelPos, 16, 68);
          }
          state.loosePanelPositions = normalizedPanelPositions;
        }
        if (saved.collapsedPanels && typeof saved.collapsedPanels === "object") {
          state.collapsedPanels = saved.collapsedPanels;
          if (saved.collapsedPanels["Quality of life"] !== undefined && saved.collapsedPanels.Qol === undefined) {
            state.collapsedPanels.Qol = !!saved.collapsedPanels["Quality of life"];
          }
        }
        if (saved.hiddenCategories && typeof saved.hiddenCategories === "object") {
          state.hiddenCategories = saved.hiddenCategories;
          if (saved.hiddenCategories["Quality of life"] !== undefined && saved.hiddenCategories.Qol === undefined) {
            state.hiddenCategories.Qol = !!saved.hiddenCategories["Quality of life"];
          }
        }
        if (saved.hiddenCategories && typeof saved.hiddenCategories === "object") {
          state.hiddenCategories = saved.hiddenCategories;
        }
        const savedModuleConfig = Array.isArray(saved.moduleConfig)
          ? saved.moduleConfig
          : (Array.isArray(saved.moduleSettings) ? saved.moduleSettings : null);
        if (savedModuleConfig) {
          const migratedModuleConfig = savedModuleConfig.map(([name, cfg]) => {
            const nextName = name === LEGACY_ANIMATION_SKIP_MODULE_NAME
              ? ANIMATION_SKIP_MODULE_NAME
              : (name === LEGACY_STYLES_MODULE_NAME ? STYLES_MODULE_NAME : name);
            const nextCfg = (cfg && typeof cfg === "object") ? { ...cfg } : cfg;
            if (nextName === ABILITY_HUD_MODULE_NAME && nextCfg && typeof nextCfg === "object") {
              delete nextCfg.abilityHudEnabled; delete nextCfg.abilityHudPositionX; delete nextCfg.abilityHudPositionY; delete nextCfg.abilityHudZIndex; delete nextCfg.abilityHudOpacity;
            }
            return [nextName, nextCfg];
          });
          state.moduleConfig = new Map(migratedModuleConfig);
        }
        if (Array.isArray(saved.enabledModules)) {
          pendingEnabledModules = saved.enabledModules
            .filter((name) => typeof name === "string")
            .map((name) => {
              if (name === LEGACY_ANIMATION_SKIP_MODULE_NAME) return ANIMATION_SKIP_MODULE_NAME;
              if (name === LEGACY_STYLES_MODULE_NAME) return STYLES_MODULE_NAME;
              return name;
            });
        }
        settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
        setFooterText();
      }
    }
  } catch (_) {}

  for (const panelName of panelByName.keys()) {
    setPanelCollapsed(panelName, !!state.collapsedPanels[panelName]);
  }
  renderHiddenCategorySettings();
  syncCollapseButtons();
  applyAppearance();
  setDisplayMode(state.displayMode);
  applySearchFilter();


  function hydrateHudConfigsFromStorage() {
    const hudModules = ["Upgrade HUD", "Building HUD", ABILITY_HUD_MODULE_NAME];
    for (const moduleName of hudModules) {
      const cfg = moduleCfg(moduleName);
      if (!cfg || typeof cfg !== "object") continue;
      let didPatch = false;
      if (moduleName === "Upgrade HUD") {
        const normalized = readUpgradeHudConfig();
        for (const [k,v] of Object.entries(normalized)) { if (cfg[k] === undefined) { cfg[k]=v; didPatch = true; } }
      } else if (moduleName === "Building HUD") {
        const normalized = readBuildingHudConfig();
        for (const [k,v] of Object.entries(normalized)) { if (cfg[k] === undefined) { cfg[k]=v; didPatch = true; } }
      } else {
        const normalized = getAbilityHudConfigFromRaw(cfg);
        for (const [k,v] of Object.entries(normalized)) { if (cfg[k] === undefined) { cfg[k]=v; didPatch = true; } }
        const pos = normalizeHudPosition(cfg.hudPosition, null);
        if (cfg.hudPosition === undefined && pos) { cfg.hudPosition = pos; didPatch = true; }
      }
      if (didPatch && typeof saveSettings === "function") saveSettings();
    }
  }
  hydrateHudConfigsFromStorage();
  for (const moduleName of pendingEnabledModules) {
    const moduleInstance = state.modules.get(moduleName);
    if (!moduleInstance || moduleInstance.enabled || moduleCfg(moduleName).hold) continue;
    toggleModule(moduleName);
  }

  const isTypingTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  };

  function setVisible(nextVisible) {
    state.visible = nextVisible;
    root.classList.toggle("anrrgm-hidden", !nextVisible);
    if (!nextVisible) closeConfig();
    if (nextVisible && state.searchAutofocus) {
      requestAnimationFrame(() => {
        searchInput.focus();
        if (searchInput.value === CONFIG.toggleKey) {
          searchInput.value = "";
          state.searchQuery = "";
          applySearchFilter();

        }
      });
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!configBackdrop.classList.contains("hidden")) {
        event.preventDefault();
        closeConfig();
        return;
      }
    }

    if (state.listeningForMenuBind) {
      event.preventDefault();
      CONFIG.toggleKey = event.key;
      settingsMenuKeyBtn.textContent = `Menu Key: ${CONFIG.toggleKey}`;
      setFooterText();
      state.listeningForMenuBind = false;
      saveSettings();
      return;
    }

    if (state.listeningForBind && openConfigModule === state.listeningForBind) {
      event.preventDefault();
      const cfg = moduleCfg(openConfigModule);
      cfg.keybind = event.key;
      const item = state.moduleItems.get(openConfigModule);
      if (item) setBindLabel(item, openConfigModule);
      setCurrentBindText(cfg.keybind);
      setBindButtonText("Set keybind");
      state.listeningForBind = null;
      saveSettings();
      return;
    }

    if (event.key === CONFIG.toggleKey) {
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setVisible(!state.visible);
      return;
    }

    if (isTypingTarget(event.target)) return;

    if (state.enabledModules.has(CAMERA_ZOOM_MODULE_NAME)) {
      const cfg = moduleCfg(CAMERA_ZOOM_MODULE_NAME);
      let nextZoom = Number(cfg.zoom ?? CAMERA_ZOOM_DEFAULT) || CAMERA_ZOOM_DEFAULT;
      if (event.key === "[") {
        event.preventDefault();
        nextZoom = clampCameraZoom(nextZoom - CAMERA_ZOOM_STEP);
      } else if (event.key === "]") {
        event.preventDefault();
        nextZoom = clampCameraZoom(nextZoom + CAMERA_ZOOM_STEP);
      } else if (event.key === "\\") {
        event.preventDefault();
        nextZoom = CAMERA_ZOOM_DEFAULT;
      }
      if (nextZoom !== Number(cfg.zoom ?? CAMERA_ZOOM_DEFAULT)) {
        cfg.zoom = nextZoom;
        showCameraZoomToast(nextZoom);
        saveSettings();
      }
    }

    for (const [moduleName, cfg] of ensureModuleConfigStore()) {
      if (!cfg.keybind || cfg.keybind !== event.key) continue;
      event.preventDefault();
      if (cfg.hold) {
        if (!event.repeat) setModuleEnabled(moduleName, true, { persist: false });
      } else if (!event.repeat) {
        toggleModule(moduleName);
      }
    }
  });

  document.addEventListener("keyup", (event) => {
    for (const [moduleName, cfg] of ensureModuleConfigStore()) {
      if (!cfg.hold || !cfg.keybind || cfg.keybind !== event.key) continue;
      event.preventDefault();
      setModuleEnabled(moduleName, false, { persist: false });
    }
  });

  // Intentionally no backdrop click-to-close; menus close only via explicit close buttons.

  topbar.addEventListener("mousedown", (event) => {
    const interactiveTarget = event.target instanceof Element
      ? event.target.closest("input, button")
      : null;
    if (interactiveTarget) return;

    const rootBox = root.getBoundingClientRect();
    if (state.displayMode === "loose") {
      const box = topbar.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const scale = getShellScale();
      dragState = {
        mode: "topbar",
        offsetX: event.clientX - box.left,
        offsetY: event.clientY - box.top,
        shellLeft: shellRect.left,
        shellTop: shellRect.top,
        scale,
      };
    } else {
      dragState = {
        mode: "root",
        offsetX: event.clientX - rootBox.left,
        offsetY: event.clientY - rootBox.top,
      };
    }
    event.preventDefault();
  });

  panelByName.forEach((panel, panelName) => {
    const header = panel.querySelector(".anrrgm-panel-header");
    header.addEventListener("mousedown", (event) => {
      if (state.displayMode !== "loose") return;
      const box = panel.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const scale = getShellScale();
      panelDragState.panelName = panelName;
      panelDragState.offsetX = event.clientX - box.left;
      panelDragState.offsetY = event.clientY - box.top;
      panelDragState.shellLeft = shellRect.left;
      panelDragState.shellTop = shellRect.top;
      panelDragState.scale = scale;
      event.preventDefault();
      event.stopPropagation();
    });
  });

  document.addEventListener("mousemove", (event) => {
    if (dragState?.mode === "root") {
      const clamped = clampToViewport(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, root);
      root.style.left = `${clamped.x}px`;
      root.style.top = `${clamped.y}px`;
      hasPositionChanges = true;
    }

    if (dragState?.mode === "topbar") {
      const scale = dragState.scale || 1;
      const unclampedX = (event.clientX - dragState.offsetX - dragState.shellLeft) / scale;
      const unclampedY = (event.clientY - dragState.offsetY - dragState.shellTop) / scale;
      const clamped = clampLoosePosition(unclampedX, unclampedY, topbar, scale, {
        left: dragState.shellLeft,
        top: dragState.shellTop,
      });
      state.loosePositions.topbar = clamped;
      topbar.style.left = `${clamped.x}px`;
      topbar.style.top = `${clamped.y}px`;
      hasPositionChanges = true;
    }

    if (panelDragState.panelName) {
      const panel = panelByName.get(panelDragState.panelName);
      if (panel) {
        const scale = panelDragState.scale || 1;
        const unclampedX = (event.clientX - panelDragState.offsetX - panelDragState.shellLeft) / scale;
        const unclampedY = (event.clientY - panelDragState.offsetY - panelDragState.shellTop) / scale;
        const clamped = clampLoosePosition(unclampedX, unclampedY, panel, scale, {
          left: panelDragState.shellLeft,
          top: panelDragState.shellTop,
        });
        state.loosePanelPositions[panelDragState.panelName] = clamped;
        panel.style.left = `${clamped.x}px`;
        panel.style.top = `${clamped.y}px`;
        hasPositionChanges = true;
      }
    }
  });

  document.addEventListener("mouseup", () => {
    const shouldSave = hasPositionChanges || hasSizeChanges;
    dragState = null;
    resizeState = null;
    panelDragState.panelName = null;
    panelDragState.shellLeft = 0;
    panelDragState.shellTop = 0;
    panelDragState.scale = 1;
    hasPositionChanges = false;
    hasSizeChanges = false;
    if (shouldSave) saveSettings();
  });

  resizeHandle.addEventListener("mousedown", (event) => {
    if (state.displayMode === "loose") return;
    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: state.shellWidth,
      startHeight: state.shellHeight,
    };
    event.preventDefault();
    event.stopPropagation();
  });

  document.addEventListener("mousemove", (event) => {
    if (!resizeState || state.displayMode === "loose") return;

    const width = Math.max(760, resizeState.startWidth + (event.clientX - resizeState.startX));
    const height = Math.max(420, resizeState.startHeight + (event.clientY - resizeState.startY));
    state.shellWidth = width;
    state.shellHeight = height;
    shell.style.width = `${width}px`;
    shell.style.height = `${height}px`;
    hasSizeChanges = true;
  });

  // Theme category switching functionality
  const themeCategories = [...settingsMenu.querySelectorAll(".anrrgm-theme-category")];
  const themeSections = [...settingsMenu.querySelectorAll(".anrrgm-theme-section")];

  themeCategories.forEach((category) => {
    category.addEventListener("click", () => {
      const targetCategory = category.dataset.category;
      
      // Update active category
      themeCategories.forEach((cat) => cat.classList.toggle("active", cat === category));
      
      // Show corresponding section
      themeSections.forEach((section) => {
        section.classList.toggle("active", section.dataset.section === targetCategory);
      });
    });
  });

  } // end initUi

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUi, { once: true });
  } else {
    initUi();
  }
})();
