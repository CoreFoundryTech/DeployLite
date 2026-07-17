// Vitest global setup: ensure DEPLOYLITE_SECRET_KEY is set before any test
// module is imported so the env secret cipher can be constructed during
// `createApiState`. The value is intentionally long enough to satisfy the
// minimum-length guard implemented in `packages/config/src/crypto.ts`.
process.env.DEPLOYLITE_SECRET_KEY ??= "test_fixture_vitest_secret_key_1234567890";
