require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const pool = require("./db");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_PORT_RETRIES = 10;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    setFlash(req, "error", "Please login first.");
    return res.redirect("/");
  }
  return next();
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) {
      setFlash(req, "error", "Please login first.");
      return res.redirect("/");
    }

    if (!allowedRoles.includes(req.session.user.role)) {
      setFlash(req, "error", "Unauthorized route for your role.");
      return res.redirect("/dashboard");
    }

    return next();
  };
}

function requireStaffSubRole(subRole) {
  return (req, res, next) => {
    if (!req.session.user) {
      setFlash(req, "error", "Please login first.");
      return res.redirect("/");
    }

    if (req.session.user.role !== "STAFF" || req.session.user.subRole !== subRole) {
      setFlash(req, "error", "Unauthorized route for your staff role.");
      return res.redirect("/dashboard");
    }

    return next();
  };
}

function generateUhid() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `UHID-${yyyy}${mm}${dd}-${rand}`;
}

function normalizeMysqlError(err) {
  if (!err) {
    return "Unknown error.";
  }

  if (err.code === "ER_DUP_ENTRY") {
    return "Duplicate value detected. Please use unique details.";
  }

  if (err.code === "ER_NO_REFERENCED_ROW_2") {
    return "Referenced record does not exist.";
  }

  if (err.code === "ER_CHECK_CONSTRAINT_VIOLATED") {
    return "Validation failed due to a database check constraint.";
  }

  return err.message || "Unexpected error.";
}

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  return res.render("login", { title: "CareSync Login" });
});

app.post("/login", async (req, res) => {
  const { role, identifier, password } = req.body;

  if (!role || !identifier || !password) {
    setFlash(req, "error", "Role, email/contact, and password are required.");
    return res.redirect("/");
  }

  try {
    let rows = [];
    let userType = role.toUpperCase();

    if (userType === "ADMIN") {
      [rows] = await pool.query(
        "SELECT admin_id AS id, name, email, password_hash FROM admin WHERE email = ? LIMIT 1",
        [identifier]
      );
    } else if (userType === "DOCTOR") {
      [rows] = await pool.query(
        "SELECT doctor_id AS id, name, email, password_hash FROM doctor WHERE email = ? LIMIT 1",
        [identifier]
      );
    } else if (userType === "STAFF") {
      [rows] = await pool.query(
        "SELECT staff_id AS id, name, email, role AS staff_role, password_hash FROM staff WHERE email = ? LIMIT 1",
        [identifier]
      );
    } else if (userType === "PATIENT") {
      // Patient schema has no email field, so login uses contact or UHID.
      [rows] = await pool.query(
        "SELECT patient_id AS id, name, uhid, contact, password_hash FROM patient WHERE contact = ? OR uhid = ? LIMIT 1",
        [identifier, identifier]
      );
    } else {
      setFlash(req, "error", "Invalid role selected.");
      return res.redirect("/");
    }

    if (!rows.length) {
      setFlash(req, "error", "Invalid credentials.");
      return res.redirect("/");
    }

    const user = rows[0];
    const isValid = password === user.password_hash;

    if (!isValid) {
      setFlash(req, "error", "Invalid credentials.");
      return res.redirect("/");
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      role: userType,
      subRole: userType === "STAFF" ? user.staff_role : null
    };

    return res.redirect("/dashboard");
  } catch (err) {
    setFlash(req, "error", `Login failed: ${normalizeMysqlError(err)}`);
    return res.redirect("/");
  }
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/dashboard", requireAuth, (req, res) => {
  const { role, subRole } = req.session.user;

  if (role === "ADMIN") return res.redirect("/admin/dashboard");
  if (role === "DOCTOR") return res.redirect("/doctor/dashboard");
  if (role === "PATIENT") return res.redirect("/patient/dashboard");

  if (role === "STAFF" && subRole === "FRONT_DESK") return res.redirect("/staff/front-desk/dashboard");
  if (role === "STAFF" && subRole === "PHARMACIST") return res.redirect("/staff/pharmacist/dashboard");
  if (role === "STAFF" && subRole === "BILLING") return res.redirect("/staff/billing/dashboard");

  setFlash(req, "error", "No dashboard available for this account.");
  return res.redirect("/");
});

app.get("/admin/dashboard", requireRole(["ADMIN"]), async (req, res) => {
  try {
    const [wards] = await pool.query("SELECT * FROM ward ORDER BY ward_id DESC");
    const [beds] = await pool.query(
      `SELECT b.bed_id, w.ward_name, b.bed_number, b.status, b.price_per_day
       FROM bed b
       JOIN ward w ON w.ward_id = b.ward_id
       ORDER BY b.bed_id DESC`
    );
    const [staff] = await pool.query("SELECT staff_id, name, role, email, contact FROM staff ORDER BY staff_id DESC");
    const [doctors] = await pool.query(
      `SELECT d.doctor_id, d.name, d.specialization, d.email, d.contact, w.ward_name
       FROM doctor d
       LEFT JOIN ward w ON w.ward_id = d.ward_id
       ORDER BY d.doctor_id DESC`
    );
    const [suppliers] = await pool.query("SELECT * FROM supplier ORDER BY supplier_id DESC");
    const [labTests] = await pool.query("SELECT * FROM lab_test ORDER BY test_id DESC");

    return res.render("admin-dashboard", {
      title: "Admin Dashboard",
      wards,
      beds,
      staff,
      doctors,
      suppliers,
      labTests
    });
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
    return res.redirect("/dashboard");
  }
});

app.post("/admin/wards", requireRole(["ADMIN"]), async (req, res) => {
  const { ward_name, ward_type } = req.body;

  try {
    await pool.query("INSERT INTO ward (ward_name, ward_type) VALUES (?, ?)", [ward_name, ward_type]);
    setFlash(req, "success", "Ward created successfully.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/wards/:wardId/delete", requireRole(["ADMIN"]), async (req, res) => {
  const wardId = Number(req.params.wardId);

  try {
    const [result] = await pool.query("DELETE FROM ward WHERE ward_id = ?", [wardId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Ward not found.");
    } else {
      setFlash(req, "success", "Ward deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/beds", requireRole(["ADMIN"]), async (req, res) => {
  const { ward_id, bed_number, status, price_per_day } = req.body;

  try {
    await pool.query(
      "INSERT INTO bed (ward_id, bed_number, status, price_per_day) VALUES (?, ?, ?, ?)",
      [ward_id, bed_number, status, price_per_day]
    );
    setFlash(req, "success", "Bed created successfully.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/beds/:bedId/delete", requireRole(["ADMIN"]), async (req, res) => {
  const bedId = Number(req.params.bedId);

  try {
    const [result] = await pool.query("DELETE FROM bed WHERE bed_id = ?", [bedId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Bed not found.");
    } else {
      setFlash(req, "success", "Bed deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/beds/:bedId/maintenance", requireRole(["ADMIN"]), async (req, res) => {
  const bedId = Number(req.params.bedId);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [bedRows] = await conn.query(
      "SELECT bed_id, status FROM bed WHERE bed_id = ? FOR UPDATE",
      [bedId]
    );

    if (!bedRows.length) {
      throw new Error("Bed not found.");
    }

    if (bedRows[0].status === "OCCUPIED") {
      throw new Error("Occupied beds cannot be moved to maintenance.");
    }

    if (bedRows[0].status === "UNDER_MAINTENANCE") {
      throw new Error("Bed is already under maintenance.");
    }

    await conn.query(
      "UPDATE bed SET status = 'UNDER_MAINTENANCE' WHERE bed_id = ?",
      [bedId]
    );

    await conn.commit();
    setFlash(req, "success", "Bed marked as under maintenance.");
  } catch (err) {
    await conn.rollback();
    setFlash(req, "error", normalizeMysqlError(err));
  } finally {
    conn.release();
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/beds/:bedId/available", requireRole(["ADMIN"]), async (req, res) => {
  const bedId = Number(req.params.bedId);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [bedRows] = await conn.query(
      "SELECT bed_id, status FROM bed WHERE bed_id = ? FOR UPDATE",
      [bedId]
    );

    if (!bedRows.length) {
      throw new Error("Bed not found.");
    }

    if (bedRows[0].status === "AVAILABLE") {
      throw new Error("Bed is already available.");
    }

    if (bedRows[0].status === "OCCUPIED") {
      throw new Error("Occupied beds cannot be manually set to available.");
    }

    await conn.query(
      "UPDATE bed SET status = 'AVAILABLE' WHERE bed_id = ?",
      [bedId]
    );

    await conn.commit();
    setFlash(req, "success", "Bed marked as available.");
  } catch (err) {
    await conn.rollback();
    setFlash(req, "error", normalizeMysqlError(err));
  } finally {
    conn.release();
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/staff", requireRole(["ADMIN"]), async (req, res) => {
  const { name, role, email, contact, password } = req.body;

  try {
    await pool.query(
      "INSERT INTO staff (name, role, email, password_hash, contact) VALUES (?, ?, ?, ?, ?)",
      [name, role, email, password, contact]
    );
    setFlash(req, "success", "Staff account created.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/staff/:staffId/delete", requireRole(["ADMIN"]), async (req, res) => {
  const staffId = Number(req.params.staffId);

  try {
    const [result] = await pool.query("DELETE FROM staff WHERE staff_id = ?", [staffId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Staff record not found.");
    } else {
      setFlash(req, "success", "Staff record deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/doctors", requireRole(["ADMIN"]), async (req, res) => {
  const { ward_id, name, specialization, contact, email, password } = req.body;

  try {
    await pool.query(
      "INSERT INTO doctor (ward_id, name, specialization, contact, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
      [ward_id || null, name, specialization, contact, email, password]
    );
    setFlash(req, "success", "Doctor account created.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/doctors/:doctorId/delete", requireRole(["ADMIN"]), async (req, res) => {
  const doctorId = Number(req.params.doctorId);

  try {
    const [result] = await pool.query("DELETE FROM doctor WHERE doctor_id = ?", [doctorId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Doctor record not found.");
    } else {
      setFlash(req, "success", "Doctor record deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/suppliers", requireRole(["ADMIN"]), async (req, res) => {
  const { name, contact, email, address } = req.body;

  try {
    await pool.query(
      "INSERT INTO supplier (name, contact, email, address) VALUES (?, ?, ?, ?)",
      [name, contact, email, address]
    );
    setFlash(req, "success", "Supplier created.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/suppliers/:supplierId/delete", requireRole(["ADMIN"]), async (req, res) => {
  const supplierId = Number(req.params.supplierId);

  try {
    const [result] = await pool.query("DELETE FROM supplier WHERE supplier_id = ?", [supplierId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Supplier not found.");
    } else {
      setFlash(req, "success", "Supplier deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/lab-tests", requireRole(["ADMIN"]), async (req, res) => {
  const { test_name, normal_range, price } = req.body;

  try {
    await pool.query(
      "INSERT INTO lab_test (test_name, normal_range, price) VALUES (?, ?, ?)",
      [test_name, normal_range || null, price]
    );
    setFlash(req, "success", "Lab test added.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.post("/admin/lab-tests/:testId/delete", requireRole(["ADMIN"]), async (req, res) => {
  const testId = Number(req.params.testId);

  try {
    const [result] = await pool.query("DELETE FROM lab_test WHERE test_id = ?", [testId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Lab test not found.");
    } else {
      setFlash(req, "success", "Lab test deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/admin/dashboard");
});

app.get("/staff/pharmacist/dashboard", requireStaffSubRole("PHARMACIST"), async (req, res) => {
  try {
    const [suppliers] = await pool.query("SELECT supplier_id, name FROM supplier ORDER BY name ASC");
    const [medicines] = await pool.query(
      `SELECT m.medicine_id, m.name, s.name AS supplier_name, m.stock_quantity, m.reorder_level,
              m.unit_price, m.expiry_date
       FROM medicine m
       LEFT JOIN supplier s ON s.supplier_id = m.supplier_id
       ORDER BY m.medicine_id DESC`
    );
    const [reorders] = await pool.query(
      `SELECT r.log_id, m.name AS medicine_name, r.log_date, r.quantity_needed, r.status
       FROM reorder_log r
       JOIN medicine m ON m.medicine_id = r.medicine_id
       ORDER BY r.log_id DESC`
    );

    return res.render("pharmacist-dashboard", {
      title: "Pharmacist Dashboard",
      suppliers,
      medicines,
      reorders
    });
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
    return res.redirect("/dashboard");
  }
});

app.post("/staff/pharmacist/medicines", requireStaffSubRole("PHARMACIST"), async (req, res) => {
  const { supplier_id, name, stock_quantity, unit_price, reorder_level, expiry_date } = req.body;

  try {
    const today = new Date();
    const exp = new Date(expiry_date);
    today.setHours(0, 0, 0, 0);
    exp.setHours(0, 0, 0, 0);

    if (Number.isNaN(exp.getTime()) || exp <= today) {
      setFlash(req, "error", "Expiry date must be a valid future date.");
      return res.redirect("/staff/pharmacist/dashboard");
    }

    await pool.query(
      `INSERT INTO medicine (supplier_id, name, stock_quantity, unit_price, reorder_level, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [supplier_id || null, name, stock_quantity, unit_price, reorder_level, expiry_date]
    );

    setFlash(req, "success", "Medicine added to inventory.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/pharmacist/dashboard");
});

app.post("/staff/pharmacist/medicines/:medicineId/delete", requireStaffSubRole("PHARMACIST"), async (req, res) => {
  const medicineId = Number(req.params.medicineId);

  try {
    const [result] = await pool.query("DELETE FROM medicine WHERE medicine_id = ?", [medicineId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Medicine not found.");
    } else {
      setFlash(req, "success", "Medicine deleted from inventory.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/pharmacist/dashboard");
});

app.get("/staff/front-desk/dashboard", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  try {
    const [patients] = await pool.query(
      "SELECT patient_id, uhid, name, contact, severity_score, registration_date FROM patient ORDER BY patient_id DESC LIMIT 25"
    );
    const [doctors] = await pool.query(
      "SELECT doctor_id, name, specialization FROM doctor ORDER BY name ASC"
    );
    const [appointments] = await pool.query(
      `SELECT a.appointment_id, p.name AS patient_name, d.name AS doctor_name,
              a.appointment_date, a.time_slot, a.status
       FROM appointment a
       JOIN patient p ON p.patient_id = a.patient_id
       JOIN doctor d ON d.doctor_id = a.doctor_id
       ORDER BY a.appointment_date DESC, a.time_slot DESC
       LIMIT 25`
    );
    const [availableBeds] = await pool.query(
      `SELECT b.bed_id, w.ward_name, b.bed_number, b.price_per_day
       FROM bed b
       JOIN ward w ON w.ward_id = b.ward_id
       WHERE b.status = 'AVAILABLE'
       ORDER BY w.ward_name, b.bed_number`
    );
    const [admissions] = await pool.query(
      `SELECT a.admission_id, p.name AS patient_name, d.name AS doctor_name,
              a.admission_date, a.discharge_date, a.status
       FROM admission a
       JOIN patient p ON p.patient_id = a.patient_id
       LEFT JOIN doctor d ON d.doctor_id = a.doctor_id
       ORDER BY a.admission_id DESC
       LIMIT 25`
    );

    return res.render("frontdesk-dashboard", {
      title: "Front Desk Dashboard",
      patients,
      doctors,
      appointments,
      availableBeds,
      admissions
    });
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
    return res.redirect("/dashboard");
  }
});

app.post("/staff/front-desk/patients", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  const {
    name,
    contact,
    blood_pressure,
    heart_rate,
    oxygen_level,
    severity_score,
    password
  } = req.body;

  try {
    let uhid = generateUhid();
    let inserted = false;

    // Retry generation in rare collision cases.
    for (let i = 0; i < 5 && !inserted; i += 1) {
      try {
        await pool.query(
          `INSERT INTO patient
          (uhid, name, contact, blood_pressure, heart_rate, oxygen_level, severity_score, password_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uhid,
            name,
            contact,
            blood_pressure || null,
            heart_rate || null,
            oxygen_level || null,
            severity_score || null,
            password
          ]
        );
        inserted = true;
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
          uhid = generateUhid();
        } else {
          throw err;
        }
      }
    }

    if (!inserted) {
      setFlash(req, "error", "Could not generate unique UHID. Please retry.");
      return res.redirect("/staff/front-desk/dashboard");
    }

    setFlash(req, "success", `Patient registered with UHID: ${uhid}`);
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/front-desk/dashboard");
});

app.post("/staff/front-desk/patients/:patientId/delete", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  const patientId = Number(req.params.patientId);

  try {
    const [result] = await pool.query("DELETE FROM patient WHERE patient_id = ?", [patientId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Patient not found.");
    } else {
      setFlash(req, "success", "Patient deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/front-desk/dashboard");
});

app.post("/staff/front-desk/appointments", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  const { patient_id, doctor_id, appointment_date, time_slot, reason, status } = req.body;

  try {
    await pool.query(
      `INSERT INTO appointment
      (patient_id, doctor_id, appointment_date, time_slot, reason, status)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [patient_id, doctor_id, appointment_date, time_slot, reason || null, status || "SCHEDULED"]
    );

    setFlash(req, "success", "Appointment booked successfully.");
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      setFlash(req, "error", "Doctor is already booked for this date and time slot.");
    } else {
      setFlash(req, "error", normalizeMysqlError(err));
    }
  }

  return res.redirect("/staff/front-desk/dashboard");
});

app.post("/staff/front-desk/appointments/:appointmentId/delete", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  const appointmentId = Number(req.params.appointmentId);

  try {
    const [result] = await pool.query("DELETE FROM appointment WHERE appointment_id = ?", [appointmentId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Appointment not found.");
    } else {
      setFlash(req, "success", "Appointment deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/front-desk/dashboard");
});

app.post("/staff/front-desk/admissions", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  const { patient_id, doctor_id, bed_id, diagnosis } = req.body;
  const conn = await pool.getConnection();

  try {
    if (!bed_id) {
      throw new Error("Bed is required for admission.");
    }

    await conn.beginTransaction();

    const [bedRows] = await conn.query(
      "SELECT bed_id, status FROM bed WHERE bed_id = ? FOR UPDATE",
      [bed_id]
    );

    if (!bedRows.length) {
      throw new Error("Bed not found.");
    }

    if (bedRows[0].status !== "AVAILABLE") {
      throw new Error("Selected bed is not available.");
    }

    await conn.query(
      `INSERT INTO admission (patient_id, doctor_id, bed_id, diagnosis, status)
       VALUES (?, ?, ?, ?, 'ACTIVE')`,
      [patient_id, doctor_id || null, bed_id, diagnosis || null]
    );

    await conn.commit();

    setFlash(req, "success", "Admission created and bed allocated successfully.");
  } catch (err) {
    await conn.rollback();
    setFlash(req, "error", normalizeMysqlError(err));
  } finally {
    conn.release();
  }

  return res.redirect("/staff/front-desk/dashboard");
});

app.post("/staff/front-desk/admissions/:admissionId/delete", requireStaffSubRole("FRONT_DESK"), async (req, res) => {
  const admissionId = Number(req.params.admissionId);

  try {
    const [result] = await pool.query("DELETE FROM admission WHERE admission_id = ?", [admissionId]);
    if (!result.affectedRows) {
      setFlash(req, "error", "Admission not found.");
    } else {
      setFlash(req, "success", "Admission deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/front-desk/dashboard");
});

app.get("/doctor/dashboard", requireRole(["DOCTOR"]), async (req, res) => {
  try {
    const doctorId = req.session.user.id;

    const [appointments] = await pool.query(
      `SELECT a.appointment_id, p.patient_id, p.name AS patient_name, a.appointment_date,
              a.time_slot, a.reason, a.status
       FROM appointment a
       JOIN patient p ON p.patient_id = a.patient_id
       WHERE a.doctor_id = ?
       ORDER BY a.appointment_date ASC, a.time_slot ASC`,
      [doctorId]
    );

    const [admissions] = await pool.query(
      `SELECT a.admission_id, p.patient_id, p.name AS patient_name,
              a.admission_date, a.discharge_date, a.status, a.diagnosis
       FROM admission a
       JOIN patient p ON p.patient_id = a.patient_id
       WHERE a.doctor_id = ?
       ORDER BY a.admission_id DESC`,
      [doctorId]
    );

    const [medicines] = await pool.query(
      "SELECT medicine_id, name, stock_quantity, unit_price FROM medicine ORDER BY name ASC"
    );
    const [labTests] = await pool.query("SELECT test_id, test_name, price FROM lab_test ORDER BY test_name ASC");
    const [otherDoctors] = await pool.query(
      "SELECT doctor_id, name, specialization FROM doctor WHERE doctor_id <> ? ORDER BY name ASC",
      [doctorId]
    );
    const [prescriptions] = await pool.query(
      `SELECT p.prescription_id, p.admission_id, p.prescription_date,
              COUNT(pi.item_id) AS total_items
       FROM prescription p
       LEFT JOIN prescription_item pi ON pi.prescription_id = p.prescription_id
       WHERE p.doctor_id = ?
       GROUP BY p.prescription_id, p.admission_id, p.prescription_date
       ORDER BY p.prescription_id DESC
       LIMIT 25`,
      [doctorId]
    );
    const [testRequests] = await pool.query(
      `SELECT tr.request_id, tr.admission_id, lt.test_name, tr.request_date, tr.status
       FROM test_request tr
       JOIN lab_test lt ON lt.test_id = tr.test_id
       WHERE tr.doctor_id = ?
       ORDER BY tr.request_id DESC
       LIMIT 25`,
      [doctorId]
    );
    const [referrals] = await pool.query(
      `SELECT r.referral_id, p.name AS patient_name, d.name AS to_doctor_name,
              r.referral_date, r.status
       FROM referral r
       JOIN patient p ON p.patient_id = r.patient_id
       JOIN doctor d ON d.doctor_id = r.to_doctor_id
       WHERE r.from_doctor_id = ?
       ORDER BY r.referral_id DESC
       LIMIT 25`,
      [doctorId]
    );

    return res.render("doctor-dashboard", {
      title: "Doctor Dashboard",
      appointments,
      admissions,
      medicines,
      labTests,
      otherDoctors,
      prescriptions,
      testRequests,
      referrals
    });
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
    return res.redirect("/dashboard");
  }
});

app.post("/doctor/prescriptions", requireRole(["DOCTOR"]), async (req, res) => {
  const doctorId = req.session.user.id;
  const { admission_id } = req.body;

  try {
    const [check] = await pool.query(
      "SELECT admission_id, status FROM admission WHERE admission_id = ? LIMIT 1",
      [admission_id]
    );

    if (!check.length) {
      setFlash(req, "error", "Admission does not exist.");
      return res.redirect("/doctor/dashboard");
    }

    if (check[0].status !== "ACTIVE") {
      setFlash(req, "error", "Only currently admitted (ACTIVE) patients can receive prescriptions.");
      return res.redirect("/doctor/dashboard");
    }

    const [result] = await pool.query(
      "INSERT INTO prescription (admission_id, doctor_id) VALUES (?, ?)",
      [admission_id, doctorId]
    );

    setFlash(req, "success", `Prescription created (ID: ${result.insertId}).`);
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/prescriptions/:prescriptionId/delete", requireRole(["DOCTOR"]), async (req, res) => {
  const doctorId = req.session.user.id;
  const prescriptionId = Number(req.params.prescriptionId);

  try {
    const [result] = await pool.query(
      "DELETE FROM prescription WHERE prescription_id = ? AND doctor_id = ?",
      [prescriptionId, doctorId]
    );

    if (!result.affectedRows) {
      setFlash(req, "error", "Prescription not found or not owned by you.");
    } else {
      setFlash(req, "success", "Prescription deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/prescriptions/:prescriptionId/items", requireRole(["DOCTOR"]), async (req, res) => {
  const prescriptionId = Number(req.params.prescriptionId);
  const { medicine_id, quantity } = req.body;

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [presRows] = await conn.query(
      `SELECT p.prescription_id, a.status
       FROM prescription p
       JOIN admission a ON a.admission_id = p.admission_id
       WHERE p.prescription_id = ?
       LIMIT 1`,
      [prescriptionId]
    );

    if (!presRows.length) {
      throw new Error("Prescription not found.");
    }

    if (presRows[0].status !== "ACTIVE") {
      throw new Error("Cannot add medicines to a discharged admission.");
    }

    const [medRows] = await conn.query(
      "SELECT medicine_id, stock_quantity FROM medicine WHERE medicine_id = ? FOR UPDATE",
      [medicine_id]
    );

    if (!medRows.length) {
      throw new Error("Medicine not found.");
    }

    const currentStock = Number(medRows[0].stock_quantity);
    const qty = Number(quantity);

    if (qty <= 0) {
      throw new Error("Quantity must be greater than zero.");
    }

    if (currentStock < qty) {
      throw new Error("Insufficient medicine stock.");
    }

    await conn.query(
      `INSERT INTO prescription_item (prescription_id, medicine_id, quantity, reserved)
       VALUES (?, ?, ?, 1)`,
      [prescriptionId, medicine_id, qty]
    );

    await conn.query(
      "UPDATE medicine SET stock_quantity = stock_quantity - ? WHERE medicine_id = ?",
      [qty, medicine_id]
    );

    await conn.commit();
    setFlash(req, "success", "Prescription item added and stock updated.");
  } catch (err) {
    await conn.rollback();
    setFlash(req, "error", normalizeMysqlError(err));
  } finally {
    conn.release();
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/test-requests", requireRole(["DOCTOR"]), async (req, res) => {
  const doctorId = req.session.user.id;
  const { admission_id, test_id } = req.body;

  try {
    await pool.query(
      `INSERT INTO test_request (admission_id, test_id, doctor_id, status)
       VALUES (?, ?, ?, 'PENDING')`,
      [admission_id, test_id, doctorId]
    );

    setFlash(req, "success", "Lab test request created.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/test-requests/:requestId/delete", requireRole(["DOCTOR"]), async (req, res) => {
  const doctorId = req.session.user.id;
  const requestId = Number(req.params.requestId);

  try {
    const [result] = await pool.query(
      "DELETE FROM test_request WHERE request_id = ? AND doctor_id = ?",
      [requestId, doctorId]
    );

    if (!result.affectedRows) {
      setFlash(req, "error", "Test request not found or not owned by you.");
    } else {
      setFlash(req, "success", "Test request deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/referrals", requireRole(["DOCTOR"]), async (req, res) => {
  const fromDoctorId = req.session.user.id;
  const { to_doctor_id, patient_id, reason } = req.body;

  if (Number(to_doctor_id) === Number(fromDoctorId)) {
    setFlash(req, "error", "A doctor cannot refer to themselves.");
    return res.redirect("/doctor/dashboard");
  }

  try {
    await pool.query(
      `INSERT INTO referral
      (from_doctor_id, to_doctor_id, patient_id, reason, status)
      VALUES (?, ?, ?, ?, 'PENDING')`,
      [fromDoctorId, to_doctor_id, patient_id, reason]
    );

    setFlash(req, "success", "Referral created.");
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/referrals/:referralId/delete", requireRole(["DOCTOR"]), async (req, res) => {
  const doctorId = req.session.user.id;
  const referralId = Number(req.params.referralId);

  try {
    const [result] = await pool.query(
      "DELETE FROM referral WHERE referral_id = ? AND from_doctor_id = ?",
      [referralId, doctorId]
    );

    if (!result.affectedRows) {
      setFlash(req, "error", "Referral not found or not owned by you.");
    } else {
      setFlash(req, "success", "Referral deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.post("/doctor/admissions/:admissionId/discharge", requireRole(["DOCTOR"]), async (req, res) => {
  const doctorId = req.session.user.id;
  const admissionId = Number(req.params.admissionId);

  try {
    const [result] = await pool.query(
      `UPDATE admission
       SET status = 'DISCHARGED', discharge_date = CURDATE()
       WHERE admission_id = ?
         AND doctor_id = ?
         AND status = 'ACTIVE'
         AND CURDATE() >= admission_date`,
      [admissionId, doctorId]
    );

    if (!result.affectedRows) {
      setFlash(req, "error", "Discharge failed. Check admission ownership/status/date.");
    } else {
      setFlash(req, "success", "Admission discharged successfully.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/doctor/dashboard");
});

app.get("/staff/billing/dashboard", requireStaffSubRole("BILLING"), async (req, res) => {
  try {
    const [eligibleAdmissions] = await pool.query(
      `SELECT a.admission_id, p.name AS patient_name, a.admission_date, a.discharge_date
       FROM admission a
       JOIN patient p ON p.patient_id = a.patient_id
       LEFT JOIN bill b ON b.admission_id = a.admission_id
       WHERE a.status = 'DISCHARGED' AND b.bill_id IS NULL
       ORDER BY a.admission_id DESC`
    );

    const [bills] = await pool.query(
      `SELECT b.bill_id, b.admission_id, p.name AS patient_name, b.total_amount,
              b.payment_status, b.payment_date
       FROM bill b
       JOIN admission a ON a.admission_id = b.admission_id
       JOIN patient p ON p.patient_id = a.patient_id
       ORDER BY b.bill_id DESC`
    );

    return res.render("billing-dashboard", {
      title: "Billing Dashboard",
      eligibleAdmissions,
      bills
    });
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
    return res.redirect("/dashboard");
  }
});

app.post("/staff/billing/bills/generate", requireStaffSubRole("BILLING"), async (req, res) => {
  const { admission_id, doctor_fees } = req.body;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT
          a.admission_id,
          a.status,
          a.admission_date,
          a.discharge_date,
          COALESCE(
            GREATEST(DATEDIFF(COALESCE(a.discharge_date, CURDATE()), a.admission_date), 1) * bd.price_per_day,
            0
          ) AS room_charges,
          COALESCE((
            SELECT SUM(pi.quantity * m.unit_price)
            FROM prescription p
            JOIN prescription_item pi ON pi.prescription_id = p.prescription_id
            JOIN medicine m ON m.medicine_id = pi.medicine_id
            WHERE p.admission_id = a.admission_id
          ), 0) AS medicine_cost,
          COALESCE((
            SELECT SUM(lt.price)
            FROM test_request tr
            JOIN lab_test lt ON lt.test_id = tr.test_id
            WHERE tr.admission_id = a.admission_id
          ), 0) AS lab_cost
       FROM admission a
       LEFT JOIN bed bd ON bd.bed_id = a.bed_id
       WHERE a.admission_id = ?
       FOR UPDATE`,
      [admission_id]
    );

    if (!rows.length) {
      throw new Error("Admission not found.");
    }

    const summary = rows[0];

    if (summary.status !== "DISCHARGED") {
      throw new Error("Bill can only be generated for discharged admissions.");
    }

    const [exists] = await conn.query("SELECT bill_id FROM bill WHERE admission_id = ? LIMIT 1", [admission_id]);
    if (exists.length) {
      throw new Error("Bill already exists for this admission.");
    }

    const docFees = Number(doctor_fees || 0);
    if (docFees < 0) {
      throw new Error("Doctor fees cannot be negative.");
    }

    const roomCharges = Number(summary.room_charges || 0);
    const medCost = Number(summary.medicine_cost || 0);
    const labCost = Number(summary.lab_cost || 0);
    const total = docFees + roomCharges + medCost + labCost;

    await conn.query(
      `INSERT INTO bill
      (admission_id, doctor_fees, room_charges, medicine_cost, lab_cost, total_amount, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [admission_id, docFees, roomCharges, medCost, labCost, total]
    );

    await conn.commit();
    setFlash(req, "success", "Bill generated successfully.");
  } catch (err) {
    await conn.rollback();
    setFlash(req, "error", normalizeMysqlError(err));
  } finally {
    conn.release();
  }

  return res.redirect("/staff/billing/dashboard");
});

app.post("/staff/billing/bills/:billId/pay", requireStaffSubRole("BILLING"), async (req, res) => {
  const billId = Number(req.params.billId);

  try {
    const [result] = await pool.query(
      "UPDATE bill SET payment_status = 'PAID', payment_date = CURDATE() WHERE bill_id = ?",
      [billId]
    );

    if (!result.affectedRows) {
      setFlash(req, "error", "Bill not found.");
    } else {
      setFlash(req, "success", "Bill marked as PAID.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/billing/dashboard");
});

app.post("/staff/billing/bills/:billId/delete", requireStaffSubRole("BILLING"), async (req, res) => {
  const billId = Number(req.params.billId);

  try {
    const [result] = await pool.query("DELETE FROM bill WHERE bill_id = ?", [billId]);

    if (!result.affectedRows) {
      setFlash(req, "error", "Bill not found.");
    } else {
      setFlash(req, "success", "Bill deleted.");
    }
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
  }

  return res.redirect("/staff/billing/dashboard");
});

app.get("/patient/dashboard", requireRole(["PATIENT"]), async (req, res) => {
  try {
    const patientId = req.session.user.id;

    const [appointments] = await pool.query(
      `SELECT a.appointment_date, a.time_slot, a.status, d.name AS doctor_name, d.specialization
       FROM appointment a
       JOIN doctor d ON d.doctor_id = a.doctor_id
       WHERE a.patient_id = ?
       ORDER BY a.appointment_date DESC, a.time_slot DESC`,
      [patientId]
    );

    const [admissions] = await pool.query(
      `SELECT admission_id, admission_date, discharge_date, status, diagnosis
       FROM admission
       WHERE patient_id = ?
       ORDER BY admission_id DESC`,
      [patientId]
    );

    const [prescriptions] = await pool.query(
      `SELECT p.prescription_id,
              p.admission_id,
              p.prescription_date,
              d.name AS doctor_name,
              m.name AS medicine_name,
              pi.quantity,
              m.unit_price,
              (pi.quantity * m.unit_price) AS line_total
       FROM prescription p
       JOIN admission a ON a.admission_id = p.admission_id
       LEFT JOIN doctor d ON d.doctor_id = p.doctor_id
       LEFT JOIN prescription_item pi ON pi.prescription_id = p.prescription_id
       LEFT JOIN medicine m ON m.medicine_id = pi.medicine_id
       WHERE a.patient_id = ?
       ORDER BY p.prescription_id DESC, pi.item_id ASC`,
      [patientId]
    );

    return res.render("patient-dashboard", {
      title: "Patient Dashboard",
      appointments,
      admissions,
      prescriptions
    });
  } catch (err) {
    setFlash(req, "error", normalizeMysqlError(err));
    return res.redirect("/dashboard");
  }
});

app.use((req, res) => {
  res.status(404).render("not-found", { title: "Not Found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", {
    title: "Server Error",
    error: "An internal server error occurred."
  });
});

function startServer(port, retriesLeft) {
  const server = app.listen(port, () => {
    console.log(`CareSync server running at http://localhost:${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && retriesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy. Retrying on ${nextPort}...`);
      startServer(nextPort, retriesLeft - 1);
      return;
    }

    console.error("Failed to start server:", err.message || err);
    process.exit(1);
  });
}

startServer(PORT, MAX_PORT_RETRIES);
