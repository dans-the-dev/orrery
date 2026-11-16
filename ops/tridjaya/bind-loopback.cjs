// The API binds 0.0.0.0 (src/bin/api.ts); on the shared Tridjaya host every Orrery listener stays on loopback and nginx
// is the only way in. Same shim as the other projects on that host.
const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    if (args[0].port !== undefined && args[0].path === undefined) args[0] = { ...args[0], host: "127.0.0.1" };
  } else if (typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]))) {
    if (typeof args[1] === "string") args[1] = "127.0.0.1";
    else args.splice(1, 0, "127.0.0.1");
  }
  return listen.apply(this, args);
};
