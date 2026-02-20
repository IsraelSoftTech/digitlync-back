require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === 'production';

app.listen(PORT, () => {
  console.log(`DigiLync API running on port ${PORT}`);
  console.log(`  Mode: ${isProd ? 'production' : 'development'}`);
  console.log(`  URL: ${isProd ? 'https://api.digilync.net' : `http://localhost:${PORT}`}`);
});
