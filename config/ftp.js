/**
 * FTP storage configuration
 * Uses credentials from .env for file uploads
 */
require('dotenv').config();

module.exports = {
  host: process.env.FTP_HOST,
  port: parseInt(process.env.FTP_PORT || '21', 10),
  user: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
  secure: process.env.FTP_SECURE === 'true',
  baseDir: process.env.FTP_BASE_DIR || '/',
  baseUrl: process.env.FTP_BASE_URL || process.env.FTP_PUBLIC_BASE_URL,
  publicBaseUrl: process.env.FTP_PUBLIC_BASE_URL || process.env.FTP_BASE_URL,
};
