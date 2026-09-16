// Thin WebSocket client for the /live protocol in the design notes §7. Emits a
// 'message' CustomEvent (detail = the parsed server message) and a 'close'
// event; app.js does all of the interpretation.
export class LiveClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
  }

  connect({ scenario, level, voice, halfDuplex, feedbackDetail }) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/live`);
      this.ws = ws;

      const onOpen = () => {
        this.send({ type: 'start', scenario, level, voice, halfDuplex, feedbackDetail });
        resolve();
      };
      const onError = () => reject(new Error('Could not connect to the tutor.'));

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
        this.dispatchEvent(new CustomEvent('close'));
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
