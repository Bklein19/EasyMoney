/** Electrobun pins the app runtime independently of packageManager's development Bun. */
export function packagedBunVersion(runtimeVersions: Record<string, string> | undefined) {
  const names = Object.keys(runtimeVersions ?? {});
  if (names.length !== 1 || names[0] !== 'bun') {
    throw new Error(`Unexpected packaged runtimes: ${JSON.stringify(runtimeVersions)}`);
  }
  const version = runtimeVersions?.bun;
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Packaged Bun runtime version is missing or invalid');
  }
  return version;
}
