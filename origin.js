export function httpsOrigin(value, variable) {
  const url = URL.canParse(value) && new URL(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.href !== url.origin + '/') {
    throw new Error(variable + ' must be an HTTPS origin, such as https://example.com, with no path or credentials.');
  }
  return url.origin;
}
