// Run this adapter under Bun. argv is an argument array, never a shell command.
export async function runSubprocess(argv, { signal, output }) {
  signal.throwIfAborted();
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const stop = () => child.kill('SIGKILL');
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const drain = async (stream, source) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      signal.throwIfAborted();
      await output.send({ source, text: decoder.decode(bytes, { stream: true }) });
    }
    const tail = decoder.decode();
    if (tail) await output.send({ source, text: tail });
  };
  try {
    await Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr'), child.exited]);
    signal.throwIfAborted();
    if (child.exitCode !== 0) throw new Error(`Subprocess exited: code=${child.exitCode}, signal=${child.signalCode ?? 'none'}`);
  } finally {
    signal.removeEventListener('abort', stop);
    if (child.exitCode === null) stop();
    await child.exited;
  }
}
