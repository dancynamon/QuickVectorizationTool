import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  retries: 0,
  use: {
    headless: true,
    // Serve the app from the project root
    baseURL: 'http://localhost:3987',
  },
  webServer: {
    command: 'node tests/serve.js',
    port: 3987,
    reuseExistingServer: false,
  },
});
