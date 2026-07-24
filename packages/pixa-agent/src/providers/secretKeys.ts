/** Secret-storage key holding the API key for a user-configured provider (`pixa.providers`). */
export function providerSecretKey(providerId: string): string {
  return `pixa.provider.${providerId}.apiKey`;
}
