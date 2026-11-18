import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Swallows everything written to it, so readline has nowhere to echo the typed characters. */
const mutedOutput = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});

/**
 * Asks on the terminal without echoing the answer. The question goes to stderr by hand: readline's own
 * output is the muted stream. Rejects when the input closes or the user interrupts (Ctrl-C) before answering.
 */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
    rl.once('close', () => reject(new Error('Input was closed before the password was entered.')));
    rl.once('SIGINT', () => rl.close());
    process.stderr.write(question);
    rl.question('', (answer) => {
      process.stderr.write('\n');
      resolve(answer);
      rl.close();
    });
  });
}
