import { defineConfig, loadEnv, type Plugin } from 'vite';
import { handleToken } from './token.ts';

// Dev-only token endpoint, so the API secret never reaches the browser.
// Credentials come from the agent's .env.local.
function tokenEndpoint(env: Record<string, string>): Plugin {
  return {
    name: 'livekit-token',
    configureServer(server) {
      server.middlewares.use('/api/token', (req, res) => void handleToken(env, req, res));
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [tokenEndpoint(loadEnv(mode, '../agent', ['LIVEKIT_', 'AVATAR_']))],
  // Allow sharing the dev server through VS Code port forwarding (dev tunnels).
  server: { allowedHosts: ['.devtunnels.ms'] },
}));
