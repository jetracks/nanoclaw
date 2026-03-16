console.error(
  [
    'Built-in WhatsApp auth is not bundled in this repo.',
    'For local UAT, set LOCAL_CHANNEL_ENABLED=true in .env and use the localhost channel.',
    'For external messaging channels, add the relevant channel implementation or skill first.',
  ].join(' '),
);
process.exit(1);
