// Keep beta-only EAS profiles out of the native runtime fingerprint.
// Production profiles remain transparent: any production EAS/app config change
// still changes the fingerprint and must be handled intentionally.
module.exports = {
  fileHookTransform(source, chunk, isEndOfFile) {
    if (source.type !== 'file' || source.filePath !== 'eas.json') {
      return chunk;
    }
    return transformEasJson(chunk, isEndOfFile);
  },
};

const easChunks = [];

function transformEasJson(chunk, isEndOfFile) {
  if (chunk != null) easChunks.push(Buffer.from(chunk).toString('utf8'));
  if (!isEndOfFile) {
    return null;
  }

  const eas = stripBetaProfiles(JSON.parse(easChunks.join('')));
  easChunks.length = 0;
  return `${JSON.stringify(eas, null, 2)}\n`;
}

function stripBetaProfiles(eas) {
  if (!eas.build) return eas;
  for (const profileName of Object.keys(eas.build)) {
    if (profileName === 'beta-base' || profileName.startsWith('beta-')) {
      delete eas.build[profileName];
    }
  }
  return eas;
}

module.exports.stripBetaProfiles = stripBetaProfiles;
