// Thin WebSocket client for the /live protocol. Emits a
// 'message' CustomEvent (detail = the parsed server message) and a 'close'
// event when the current socket is closed from the other side (not after
// stop()); app.js does all of the interpretation.
export class LiveClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
  }

  connect({ scenario, level, voice, halfDuplex, feedbackDetail, name, memoryNote, clientId }) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/live`);
      this.ws = ws;

      const onOpen = () => {
        this.send({ type: 'start', scenario, level, voice, halfDuplex, feedbackDetail, name, memoryNote, clientId });
        resolve();
      };
      const onError = () => {
        // stop() before the socket opened is a deliberate cancel, not a
        // failure to report.
        if (ws !== this.ws) {
          reject(new DOMException('Connecting was cancelled.', 'AbortError'));
          return;
        }
        reject(new Error('Could not connect to the tutor.'));
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      });
      ws.addEventListener('close', () => {
        // Only the current socket's end matters: after stop() + a new
        // connect(), the old socket's late close must not end the new one.
        if (ws === this.ws) this.dispatchEvent(new CustomEvent('close'));
      });
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendAudio(base64) {
    this.send({ type: 'audio', data: base64 });
  }

  sendText(text) {
    this.send({ type: 'text', text });
  }

  say(text) {
    this.send({ type: 'say', text });
  }

  interrupt() {
    this.send({ type: 'interrupt' });
  }

  stop() {
    this.send({ type: 'stop' });
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
