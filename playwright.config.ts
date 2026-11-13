import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './test/browser', timeout: 60_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1200, height: 850 }, launchOptions: existsSync(edge) ? { executablePath: edge } : {} },
  webServer: { command: 'node test/serve.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
});
