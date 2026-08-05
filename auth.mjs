import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getApiKeyUser } from './store.mjs';

const JWT_SECRET = process.env.JWT_SECRET || 'neopxl-ai-secret-change-me';
const JWT_EXPIRY = '4h';

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, company_id: user.company_id, company_name: user.company_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function authGuard(req, res) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) {
    try { return verifyToken(header.slice(7)); } catch {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — invalid or expired token' }));
      return null;
    }
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = getApiKeyUser(apiKey);
    if (user) return user;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized — missing valid authentication' }));
  return null;
}
