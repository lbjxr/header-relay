import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

function getProxyAuth(proxy) {
  if (proxy.username && proxy.pw) {
    return 'Basic ' + Buffer.from(proxy.username + ':' + proxy.pw).toString('base64');
  }
  return undefined;
}

async function proxyFetch(input, init = {}, proxy) {
  const target = new URL(input);
  const isHttps = target.protocol === 'https:';
  const { host, port, protocol = 'http' } = proxy;
  const authHeader = getProxyAuth(proxy);

  const sendBody = (req, body) => {
    if (!body) {
      req.end();
      return;
    }
    if (Buffer.isBuffer(body)) {
      req.write(body);
      req.end();
    } else if (typeof body.pipe === 'function') {
      body.pipe(req);
    } else if (body[Symbol.asyncIterator]) {
      (async () => {
        try {
          for await (const chunk of body) {
            if (!req.writable) break;
            req.write(chunk);
          }
          req.end();
        } catch (e) {
          req.destroy(e);
        }
      })();
    } else {
      req.write(body);
      req.end();
    }
  };

  if (isHttps) {
    const tunnelSocket = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: host,
        port: port,
        method: 'CONNECT',
        path: target.hostname + ':' + (target.port || 443),
        headers: Object.assign({ 'Host': target.hostname + ':' + (target.port || 443) }, authHeader ? { 'Proxy-Authorization': authHeader } : {})
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error('Proxy CONNECT failed: ' + res.statusCode));
          req.destroy();
          return;
        }
        resolve(socket);
      });
      req.on('error', reject);
      req.end();
    });

    return new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({
        socket: tunnelSocket,
        servername: target.hostname,
        rejectUnauthorized: false,
      }, () => {
        const req = https.request({
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: init.method || 'GET',
          headers: init.headers || {},
          signal: init.signal,
        }, (res) => {
          resolve(res);
        });
        req.on('error', reject);
        sendBody(req, init.body);
      });
      tlsSocket.on('error', reject);
    });
  } else {
    return new Promise((resolve, reject) => {
      const proxyHeaders = Object.assign({ 'Host': target.host }, init.headers || {});
      const req = http.request({
        hostname: host,
        port: port,
        method: init.method || 'GET',
        path: target.href,
        headers: proxyHeaders,
        signal: init.signal,
      }, (res) => {
        resolve(res);
      });
      req.on('error', reject);
      sendBody(req, init.body);
    });
  }
}

export { proxyFetch };
