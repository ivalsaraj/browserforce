import net from 'node:net';

function isIntegerPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export async function pickChatdPort({ envPort, rangeStart = 19280, rangeEnd = 19320 } = {}) {
  if (isIntegerPort(envPort) && await isPortFree(envPort)) {
    return envPort;
  }

  for (let port = rangeStart; port <= rangeEnd; port += 1) {
    if (await isPortFree(port)) return port;
  }

  throw new Error(`No free port in range ${rangeStart}-${rangeEnd}`);
}
