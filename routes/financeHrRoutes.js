// routes/financeHrRoutes.js — Finance dashboard: Employees, Salary slips, Tools & Services, Notes.
// Mounted under the same bases as the invoice routes, so it inherits protectFinance / developer auth from server.js.
const express = require("express");
const router = express.Router({ mergeParams: true });
const { protectFinanceOrDeveloper } = require("../middlewares/financeAuthMiddleware");
const c = require("../controllers/financeHrController");

router.use(protectFinanceOrDeveloper);

// Employees
router.get   ("/employees",     c.listEmployees);
router.post  ("/employees",     c.createEmployee);
router.get   ("/employees/:id", c.getEmployee);
router.put   ("/employees/:id", c.updateEmployee);
router.delete("/employees/:id", c.deleteEmployee);

// Salary slips
router.get ("/salary",            c.listSalary);
router.post("/salary",            c.createSalary);
router.get ("/salary/:id",        c.getSalary);
router.put ("/salary/:id",        c.updateSalary);
router.post("/salary/:id/emailed",c.markSalaryEmailed);

// Tools & Services
router.get   ("/tools",     c.listTools);
router.post  ("/tools",     c.createTool);
router.put   ("/tools/:id", c.updateTool);
router.delete("/tools/:id", c.deleteTool);

// Notes
router.get   ("/notes",     c.listNotes);
router.post  ("/notes",     c.createNote);
router.put   ("/notes/:id", c.updateNote);
router.delete("/notes/:id", c.deleteNote);

module.exports = router;
