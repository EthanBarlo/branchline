export function validateIntegrationLink(value: string): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Choose a valid HTTPS integration link.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Choose a valid HTTPS integration link.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Choose a valid HTTPS integration link without embedded credentials.');
  return url.href;
}
