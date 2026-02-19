const express = require('express');
const router = express.Router();

// Placeholder - to be implemented per SRS Farmer Data Model
router.get('/', (req, res) => {
  res.json({ message: 'Farmers endpoint - Phase 1' });
});

module.exports = router;
