const express = require("express");
const router  = express.Router();
const { receiveWebsiteWebhook } = require("../controllers/websiteWebhookController");

router.post("/website-webhook", receiveWebsiteWebhook);

module.exports = router;