/* Token-bucket rate limiting: allows short bursts, throttles sustained floods. */
export function createBucket(rate, burst) {
  return { tokens: burst, rate, burst, last: Date.now() };
}

export function takeToken(bucket) {
  const now = Date.now();
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + ((now - bucket.last) / 1000) * bucket.rate);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/* Per-IP connection accounting. */
const connectionsByIp = new Map();

export function addConnection(ip, max) {
  const count = connectionsByIp.get(ip) || 0;
  if (count >= max) return false;
  connectionsByIp.set(ip, count + 1);
  return true;
}

export function releaseConnection(ip) {
  const count = (connectionsByIp.get(ip) || 1) - 1;
  if (count <= 0) connectionsByIp.delete(ip);
  else connectionsByIp.set(ip, count);
}
