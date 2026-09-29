// What a screen reader hears during a conversation (#31): a short cue when
// whose turn it is changes, and each finished line once. The on-screen
// transcript is rewritten many times per sentence while it streams, so it is
// not a live region itself.

const STATE_CUES = {
  listening: 'Your turn.',
  thinking: 'Parley is thinking.',
  speaking: 'Parley is speaking.',
  reconnecting: 'Reconnecting to Parley.',
};

/** @param {string} state one of the UI states */
export function stateCue(state) {
  return STATE_CUES[state] || '';
}

/**
 * The line to announce for a transcript message: only a final, non-empty
 * one, and saying who spoke.
 * @param {{ type: string, text?: string, final?: boolean }} msg
 */
export function finishedLine(msg) {
  const text = (msg.text || '').trim();
  if (!msg.final || !text) return '';
  return msg.type === 'output-text' ? `Parley: ${text}` : `You: ${text}`;
}

// Appends each announcement to a role="log" region, so two lines that land
// together (the learner's and Parley's, at the end of a turn) are both read,
// and keeps only the last few.
export class Announcer {
  /**
   * @param {HTMLElement} region
   * @param {number} [keep]
   */
  constructor(region, keep = 4) {
    this.region = region;
    this.keep = keep;
  }

  /** @param {string} text */
  say(text) {
    if (!text) return;
    const line = this.region.ownerDocument.createElement('p');
    line.textContent = text;
    this.region.append(line);
    while (this.region.childElementCount > this.keep) this.region.firstElementChild.remove();
  }
}
