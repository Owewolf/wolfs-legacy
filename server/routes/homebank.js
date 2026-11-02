'use strict';
const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth');
const hb = require('../homebank-service');
router.use(authenticateToken);
// A registered vault account is not automatically authorized to read the owner's
// private HomeBank file. The operator must designate the owner in .env.
router.use((req,res,next) => {
  const owner = (process.env.HOMEBANK_OWNER_EMAIL || '').trim().toLowerCase();
  if (!owner) return res.status(503).json({error:"Set HOMEBANK_OWNER_EMAIL in the server .env to your Wolf's Vault sign-in email"});
  if (String(req.user.email||'').trim().toLowerCase() !== owner) return res.status(403).json({error:'HomeBank financial overview is restricted to the configured vault owner'});
  next();
});
router.get('/overview', async (req, res) => {
  try { res.json(hb.responseView(await hb.syncUser(req.user.id))); }
  catch { res.status(500).json({error:'HomeBank overview unavailable'}); }
});
router.get('/files', async (req, res) => {
  try {
    const directory = req.query.directory || hb.DEFAULT_DIRECTORY;
    const files = await hb.listing(directory);
    res.json({files:files.map(f=>({name:f.name,mtime:f.mtime,size:f.size}))});
  } catch(e) { res.status(400).json({error:e.message}); }
});
router.get('/directories', async (req,res) => {
  try { res.json(await hb.directories(req.query.directory || hb.DEFAULT_DIRECTORY)); }
  catch (e) { res.status(400).json({error:e.message}); }
});
router.put('/settings', async (req,res) => {
  try { res.json(hb.responseView(await hb.saveSettings(req.user.id,req.body||{}))); }
  catch(e) { res.status(400).json({error:e.message}); }
});
router.post('/sync', async (req,res) => {
  try { res.json(hb.responseView(await hb.syncUser(req.user.id,true))); }
  catch { res.status(500).json({error:'HomeBank sync unavailable'}); }
});
module.exports=router;
