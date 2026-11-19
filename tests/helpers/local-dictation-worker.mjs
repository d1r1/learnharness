process.on('message', ({ id, pcm }) => {
  if (pcm[0] === 7) return;
  if (pcm[0] === 9) { process.exit(2); return; }
  process.send({ id, text: `fixture:${process.pid}` });
});
process.on('disconnect', () => process.exit());
