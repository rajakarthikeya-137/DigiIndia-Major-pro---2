// server.js (CLEANED & FIXED)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

/* ----------------------------------------------------------
   ROUTE NODES FOR SEAT CALCULATION
---------------------------------------------------------- */
const ROUTE_STOPS = [
  "Ameerpet",
  "Miyapur",
  "Kukatpally",
  "Hitech City",
  "Madhapur",
  "Gachibowli",
  "Jubilee Hills",
  "Banjara Hills",
  "Begumpet",
  "Secunderabad",
  "Uppal",
  "LB Nagar",
  "Dilsukhnagar",
  "Mehdipatnam",
  "Charminar",
];


function stopIndex(name) {
  return ROUTE_STOPS.indexOf(name);
}

// ⭐ Normalize Bus Numbers
function normalizeBusNo(busNo) {
  return String(busNo || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

/**
 * Calculate seat stats for a set of tickets along ROUTE_STOPS.
 * Each ticket uses 1 seat from [sourceIndex, destinationIndex).
 * capacity = 5 (for now).
 */
function calculateSeatStats(ticketsList) {
  const SITTING_CAP = 5;
  const STANDING_CAP = 5;
  const TOTAL_CAP = 10;

  const nStops = ROUTE_STOPS.length;

  // -------------------------------
  // 1️⃣ Fallback simple model
  // -------------------------------
  if (nStops < 2) {
    const total = ticketsList.length;

    const sittingUsed = Math.min(total, SITTING_CAP);
    const standingUsed =
      total > SITTING_CAP
        ? Math.min(total - SITTING_CAP, STANDING_CAP)
        : 0;

    const sittingLeft = Math.max(SITTING_CAP - sittingUsed, 0);
    const standingLeft = Math.max(STANDING_CAP - standingUsed, 0);

    let status = "Seats Available";
    if (total > 5 && total <= 10) status = "Standing Available";
    if (total > 10) status = "Overloaded";

    return {
      maxConcurrent: total,     // ⭐ FIXED (previously broken)
      totalPassengers: total,
      sittingUsed,
      standingUsed,
      sittingLeft,
      standingLeft,
      status
    };
  }

  // -------------------------------
  // 2️⃣ Multi-stop concurrency model
  // -------------------------------
  const segments = new Array(nStops - 1).fill(0);

  for (const t of ticketsList) {
    const from = stopIndex(t.source);
    const to = stopIndex(t.destination);

    if (from === -1 || to === -1 || to <= from) continue;

    for (let i = from; i < to; i++) {
      segments[i] += 1;
    }
  }

  const maxConcurrent = segments.length ? Math.max(...segments) : 0;

  const sittingUsed = Math.min(maxConcurrent, SITTING_CAP);
  const standingUsed =
    maxConcurrent > SITTING_CAP
      ? Math.min(maxConcurrent - SITTING_CAP, STANDING_CAP)
      : 0;

  const sittingLeft = Math.max(SITTING_CAP - sittingUsed, 0);
  const standingLeft = Math.max(STANDING_CAP - standingUsed, 0);

  let status = "Seats Available";
  if (maxConcurrent > 5 && maxConcurrent <= 10) status = "Standing Available";
  if (maxConcurrent > 10) status = "Overloaded";

return {
      maxConcurrent,
      totalPassengers: maxConcurrent,
      sittingUsed,
      standingUsed,
      sittingLeft,
      standingLeft,
      status
    };

}


/* ----------------------------------------------------------
   MIDDLEWARE
---------------------------------------------------------- */
app.use(
  cors({
    origin: true,
    credentials: true
  })
);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* ----------------------------------------------------------
   UPLOADS FOLDER
---------------------------------------------------------- */
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use("/uploads", express.static(uploadDir));

// People Counter Page (Protected)
app.get("/conductor/people-counter", conductorAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/people-counter.html"));
});


/* ----------------------------------------------------------
   MONGODB CONNECTION (ATLAS-SAFE + RETRY)
---------------------------------------------------------- */
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const client = new MongoClient(uri);

let applications, tickets, users, admins, conductors, businfo, buses;
let dbReady = false;

async function connectDB() {
  try {
    console.log("🔄 Connecting to MongoDB...");
    await client.connect();

    const db = client.db("mahalakshmiBusDB");

    applications = db.collection("applications");
    tickets = db.collection("tickets");
    users = db.collection("users");
    admins = db.collection("admins");
    conductors = db.collection("conductors");
    // ⭐ ADD THIS LINE
    businfo = db.collection("businfo");
    buses = db.collection("buses"); 

    dbReady = true;
    console.log("✅ MongoDB connected");
  } catch (err) {
    dbReady = false;
    console.error("❌ DB ERROR:", err.message || err);

    console.log("⏳ Retrying MongoDB connection in 5s...");
    setTimeout(connectDB, 5000);
  }
}
connectDB();


// Optional: global guard for DB-dependent routes (JSON APIs)
function ensureDB(req, res, next) {
  if (!dbReady) {
    return res
      .status(503)
      .json({ success: false, msg: "Database not ready. Please try again shortly." });
  }
  next();
}

/* ----------------------------------------------------------
   MULTER
---------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

/* ----------------------------------------------------------
   COOKIE + TOKEN HELPERS
---------------------------------------------------------- */
function parseCookies(str = "") {
  const obj = {};
  str.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) {
      const key = p.substring(0, i).trim();
      const val = decodeURIComponent(p.substring(i + 1).trim());
      if (key) obj[key] = val;
    }
  });
  return obj;
}

function getToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];

  const c = parseCookies(req.headers.cookie || "");
  if (c.token) return c.token;

  return null;
}

/* ----------------------------------------------------------
   AUTH MIDDLEWARES
---------------------------------------------------------- */
function authMiddleware(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ success: false, msg: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.isAdmin = !!decoded.isAdmin;
    req.isConductor = !!decoded.isConductor;
    next();
  } catch {
    return res.status(401).json({ success: false, msg: "Invalid token" });
  }
}

async function adminAuth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ success: false, msg: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.isAdmin) {
      req.adminId = decoded.id;
      return next();
    }

    if (!admins) {
      return res
        .status(503)
        .json({ success: false, msg: "Database not ready. Try again." });
    }

    const adminDoc = await admins.findOne({ _id: new ObjectId(decoded.id) });
    if (!adminDoc) return res.status(403).json({ success: false, msg: "Not an admin" });

    req.adminId = decoded.id;
    next();
  } catch {
    return res.status(401).json({ success: false, msg: "Invalid token" });
  }
}

/* ----------------------------------------------------------
   ⭐ CONDUCTOR AUTH MIDDLEWARE
---------------------------------------------------------- */
async function conductorAuth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ success: false, msg: "No token" });

  if (!conductors) {
    return res
      .status(503)
      .json({ success: false, msg: "Database not ready. Try again." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isConductor)
      return res.status(403).json({ success: false, msg: "Not a conductor" });

    const doc = await conductors.findOne({ _id: new ObjectId(decoded.id) });
    if (!doc)
      return res.status(403).json({ success: false, msg: "Conductor not found" });

    req.conductorId = decoded.id;
    next();
  } catch {
    res.status(401).json({ success: false, msg: "Invalid token" });
  }
}

/* ----------------------------------------------------------
   ⭐ CONDUCTOR SIGNUP
---------------------------------------------------------- */
app.post("/conductor/signup", ensureDB, async (req, res) => {
  try {
    const { name, email, password, employeeId } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ success: false, msg: "Missing fields" });

    const lc = email.toLowerCase();
    const exists = await conductors.findOne({ email: lc });

    if (exists)
      return res
        .status(400)
        .json({ success: false, msg: "Conductor already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const r = await conductors.insertOne({
      name,
      email: lc,
      password: hashed,
      employeeId: employeeId || "",
      createdAt: new Date(),
    });

    const token = jwt.sign(
      { id: r.insertedId.toString(), isConductor: true },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ CONDUCTOR LOGIN
---------------------------------------------------------- */
app.post("/conductor/login", ensureDB, async (req, res) => {
  try {
    const { email, password } = req.body;
    const lc = email.toLowerCase();

    const conductor = await conductors.findOne({ email: lc });

    if (!conductor)
      return res.status(400).json({ success: false, msg: "Invalid credentials" });

    const ok = await bcrypt.compare(password, conductor.password);
    if (!ok)
      return res.status(400).json({ success: false, msg: "Invalid credentials" });

    const token = jwt.sign(
      { id: conductor._id.toString(), isConductor: true },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ CONDUCTOR PROFILE
---------------------------------------------------------- */
app.get("/conductor/me", ensureDB, conductorAuth, async (req, res) => {
  try {
    const doc = await conductors.findOne(
      { _id: new ObjectId(req.conductorId) },
      { projection: { password: 0 } }
    );
    res.json({ success: true, conductor: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ Conductor Ticket History (Search + Filters)
---------------------------------------------------------- */
app.get("/conductor/tickets", ensureDB, conductorAuth, async (req, res) => {
  try {
    const { busNo, journeyDate, q } = req.query;

    const filter = { bookedBy: req.conductorId };

    if (busNo) filter.busNo = busNo;
    if (journeyDate) filter.journeyDate = journeyDate;

    if (q) {
      filter.$or = [{ "passenger.phone": q }, { "passenger.passId": q }];
    }

    const list = await tickets.find(filter).sort({ bookedAt: -1 }).toArray();

    res.json({ success: true, tickets: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Failed to load tickets" });
  }
});

/* ----------------------------------------------------------
   ⭐ USER — Fetch tickets booked FOR this user
   Matching based on user's phone OR passId
---------------------------------------------------------- */
app.get("/tickets/my", ensureDB, authMiddleware, async (req, res) => {
  try {
    const userId = new ObjectId(req.userId);

    // 1️⃣ User object
    const user = await users.findOne({ _id: userId });
    if (!user) {
      return res.json({ success: true, tickets: [] });
    }

    // 2️⃣ Get the user's application (if any)
    const appDoc = await applications.findOne({ createdBy: req.userId });

    const phone = appDoc?.phone || user.phone || null;
    const passId = appDoc?.passId || null;

    // 3️⃣ Build search query
    const query = {
      $or: [
        { userId },                           // NEW tickets
        { "passenger.phone": phone },         // OLD tickets
        { "passenger.passId": passId }        // OLD tickets
      ]
    };

    // Remove nulls
    query.$or = query.$or.filter(q => {
      const value = Object.values(q)[0];
      return value !== null && value !== undefined && value !== "";
    });

    const ticketsList = await tickets
      .find(query)
      .sort({ bookedAt: -1 })
      .toArray();

    res.json({ success: true, tickets: ticketsList });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      msg: "Server error while fetching tickets"
    });
  }
});


/* ----------------------------------------------------------
   USER SIGNUP / LOGIN
---------------------------------------------------------- */
app.post("/auth/signup", ensureDB, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, msg: "Missing fields" });

    const lcEmail = email.toLowerCase();
    const existing = await users.findOne({ email: lcEmail });

    if (existing)
      return res.status(400).json({ success: false, msg: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const result = await users.insertOne({
      name,
      email: lcEmail,
      password: hashed,
      createdAt: new Date(),
    });

    const token = jwt.sign(
      { id: result.insertedId.toString(), isAdmin: false },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      user: { id: result.insertedId, name, email: lcEmail },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

app.post("/auth/login", ensureDB, async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(400).json({ success: false, msg: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(400).json({ success: false, msg: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id.toString(), isAdmin: false },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// USER PROFILE (FIX FOR auth.js)
app.get("/auth/me", ensureDB, authMiddleware, async (req, res) => {
  try {
    if (req.isConductor) {
      const c = await conductors.findOne(
        { _id: new ObjectId(req.userId) },
        { projection: { password: 0 } }
      );
      return res.json({ success: true, user: c, role: "conductor" });
    }

    if (req.isAdmin) {
      const a = await admins.findOne(
        { _id: new ObjectId(req.userId) },
        { projection: { password: 0 } }
      );
      return res.json({ success: true, user: a, role: "admin" });
    }

    const u = await users.findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { password: 0 } }
    );

    if (!u) return res.status(404).json({ success: false, msg: "User not found" });

    res.json({ success: true, user: u, role: "user" });
  } catch (err) {
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   SERVE APPLY PAGE
---------------------------------------------------------- */
app.get("/apply", (req, res) => {
  const token = getToken(req);
  if (!token) return res.redirect("/login.html");

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.sendFile(path.join(__dirname, "public", "apply.html"));
  } catch {
    return res.redirect("/login.html");
  }
});

/* ----------------------------------------------------------
   APPLICATION SUBMISSION  (ONLY PHONE)
---------------------------------------------------------- */
app.post(
  "/apply",
  ensureDB,
  authMiddleware,
  upload.fields([{ name: "photo" }, { name: "aadharFile" }]),
  async (req, res) => {
    try {
      const passId = "TSRTC-" + Math.floor(10000000 + Math.random() * 90000000);
      const qr = await QRCode.toDataURL(passId);

      const doc = {
        passId,
        qrCode: qr,
        ...req.body,

        phone: req.body.phone,                 // ⭐ ONLY PHONE SAVED
        photo: req.files?.photo
          ? `/uploads/${req.files.photo[0].filename}`
          : "",
        aadharFile: req.files?.aadharFile
          ? `/uploads/${req.files.aadharFile[0].filename}`
          : "",

        status: "PENDING",
        statusNote: "",
        createdAt: new Date(),

        createdBy: req.userId,
        userId: new ObjectId(req.userId),      // ⭐ LINK USER → APPLICATION
      };

      const result = await applications.insertOne(doc);

      res.json({
        success: true,
        id: result.insertedId,
        passId,
        qrCode: qr,
      });
    } catch (err) {
      console.log(err);
      res.status(500).json({
        success: false,
        msg: "Server error",
      });
    }
  }
);

/* ----------------------------------------------------------
   FETCH ROUTES — SEARCH ONLY BY PHONE
---------------------------------------------------------- */
app.get("/verify/:phone", ensureDB, async (req, res) => {
  const phone = req.params.phone;

  const appDoc = await applications.findOne({
    phone: phone,
  });

  if (!appDoc) return res.json({ success: false });

  res.json({ success: true, id: appDoc._id });
});

app.get("/applicant/:id", ensureDB, async (req, res) => {
  const result = await applications.findOne({ _id: new ObjectId(req.params.id) });
  if (!result) return res.json({ success: false });

  res.json({ success: true, applicant: result });
});

app.get("/getApplicant/:passId", ensureDB, async (req, res) => {
  const r = await applications.findOne({ passId: req.params.passId });
  if (!r) return res.status(404).json({ success: false });

  res.json(r);
});

/* ----------------------------------------------------------
   TICKET BOOKING (FOR CONDUCTOR)
   - Accepts either application._id OR passId as applicantId
---------------------------------------------------------- */
app.post("/bookTicket", ensureDB, conductorAuth, async (req, res) => {
  try {
let { applicantId, busNo, journeyDate, source, destination } = req.body;
busNo = normalizeBusNo(busNo);

    // ❌ Prevent same stop booking
    if (source === destination) {
      return res.json({
        success: false,
        msg: "Source and destination cannot be the same."
      });
    }

    if (!applicantId || !busNo || !journeyDate || !source || !destination) {
      return res.status(400).json({
        success: false,
        msg: "Missing fields (need applicantId, busNo, journeyDate, source, destination)",
      });
    }

    // 👉 Check seat availability for this bus + journeyDate, including this new ticket
    const existingTickets = await tickets
      .find({
        busNo: String(busNo).toUpperCase(),
        journeyDate: String(journeyDate),
      })
      .toArray();

    const statsAfter = calculateSeatStats(
      [...existingTickets, { source, destination }],
      5
    );

if (statsAfter.maxConcurrent >= 10)
  return res.json({
    success: false,
    msg: "BUS FULL — Cannot book ticket now",
  });

// Try find application by _id first, then by passId
let application = null;
try {
  application = await applications.findOne({ _id: new ObjectId(applicantId) });
} catch (e) {
  // ignore invalid ObjectId error
  application = null;
}
if (!application) {
  application = await applications.findOne({ passId: String(applicantId) });
}

if (!application) {
  return res.status(404).json({ success: false, msg: "Applicant not found" });
}

const passenger = {
  name: application.name || "",
  phone: application.phone || "",
  photo: application.photo || "",
  aadharFile: application.aadharFile || "",
  passId: application.passId || "",
};

const ticket = {
  busNo: String(busNo),
  journeyDate: String(journeyDate),
  source,
  destination,
  paymentType: req.body.paymentType,
  amount:
    req.body.paymentType === "PAID"
      ? Number(req.body.amount) || 0
      : 0,
  passenger,

  userId: application.userId || null,
  applicationId: application._id || null,

  bookedAt: new Date(),
  bookedBy: req.conductorId,
};
const r = await tickets.insertOne(ticket);
return res.json({ success: true, ticket: { _id: r.insertedId, ...ticket } });

} catch (err) {
  console.error(err);
  return res.status(500).json({ success: false, msg: "Booking failed" });
}

}); // <-- closes app.post("/bookTicket")


/* ----------------------------------------------------------
   ADMIN ROUTES
---------------------------------------------------------- */

// ADMIN SIGNUP
app.post("/admin/signup", ensureDB, async (req, res) => {
  try {
    const { name, email, password, adminSecret } = req.body;
    if (!name || !email || !password || !adminSecret)
      return res.status(400).json({ success: false, msg: "Missing fields" });

    if (!process.env.ADMIN_SECRET)
      return res
        .status(500)
        .json({ success: false, msg: "ADMIN_SECRET not configured" });

    if (adminSecret !== process.env.ADMIN_SECRET)
      return res
        .status(403)
        .json({ success: false, msg: "Invalid admin secret" });

    const lcEmail = email.toLowerCase();
    const existing = await admins.findOne({ email: lcEmail });
    if (existing)
      return res
        .status(400)
        .json({ success: false, msg: "Admin already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const r = await admins.insertOne({
      name,
      email: lcEmail,
      password: hashed,
      createdAt: new Date(),
    });

    const token = jwt.sign(
      { id: r.insertedId.toString(), isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      admin: { id: r.insertedId, name, email: lcEmail },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// ADMIN LOGIN
app.post("/admin/login", ensureDB, async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await admins.findOne({ email: email.toLowerCase() });
    if (!admin)
      return res.status(400).json({ success: false, msg: "Invalid credentials" });

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok)
      return res.status(400).json({ success: false, msg: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin._id.toString(), isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      admin: { id: admin._id, name: admin.name, email: admin.email },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// ADMIN HOME
app.get("/admin", (req, res) => {
  const token = getToken(req);
  if (!token) return res.redirect("/admin/login.html");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.isAdmin) return res.redirect("/admin/login.html");

    return res.sendFile(path.join(__dirname, "public", "admin", "dashboard.html"));
  } catch (err) {
    return res.redirect("/admin/login.html");
  }
});

// ADMIN PROFILE
app.get("/admin/me", ensureDB, adminAuth, async (req, res) => {
  try {
    const admin = await admins.findOne(
      { _id: new ObjectId(req.adminId) },
      { projection: { password: 0 } }
    );

    if (!admin) return res.status(404).json({ success: false, msg: "Admin not found" });

    res.json({ success: true, admin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ADMIN APPLICATION CRUD
---------------------------------------------------------- */

// GET ALL
app.get("/admin/applications", ensureDB, adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const q = {};
    if (status) q.status = status;

    const pageNum = Math.max(1, Number(page));
    const lim = Math.max(1, Math.min(200, Number(limit)));

    const cursor = applications
      .find(q)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * lim)
      .limit(lim);

    const data = await cursor.toArray();
    const total = await applications.countDocuments(q);

    res.json({ success: true, total, applications: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// GET ONE
app.get("/admin/application/:id", ensureDB, adminAuth, async (req, res) => {
  try {
    const doc = await applications.findOne({ _id: new ObjectId(req.params.id) });

    if (!doc)
      return res.status(404).json({ success: false, msg: "Not found" });

    res.json({ success: true, application: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// UPDATE — ONLY PHONE
app.put("/admin/application/:id", ensureDB, adminAuth, async (req, res) => {
  try {
    const updates = {
      name: req.body.name ?? "",
      phone: req.body.phone ?? "",
      address: req.body.address ?? "",
      updatedAt: new Date(),
      updatedByAdmin: req.adminId,
    };

    for (const k in updates) {
      if (updates[k] === undefined || updates[k] === "undefined") {
        updates[k] = "";
      }
    }

    await applications.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updates }
    );

    res.json({ success: true, updated: updates });
  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, msg: "Update failed" });
  }
});

/* FILE UPLOAD */
app.post(
  "/admin/application/:id/upload",
  ensureDB,
  adminAuth,
  upload.fields([{ name: "photo" }, { name: "aadharFile" }]),
  async (req, res) => {
    try {
      const updates = {};

      if (req.files?.photo) {
        updates.photo = `/uploads/${req.files.photo[0].filename}`;
      }
      if (req.files?.aadharFile) {
        updates.aadharFile = `/uploads/${req.files.aadharFile[0].filename}`;
      }

      if (Object.keys(updates).length === 0)
        return res.json({ success: false, msg: "No files uploaded" });

      updates.updatedAt = new Date();
      updates.updatedByAdmin = req.adminId;

      await applications.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updates }
      );

      res.json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false, msg: "Upload error" });
    }
  }
);

// UPDATE STATUS
app.patch(
  "/admin/application/:id/status",
  ensureDB,
  adminAuth,
  async (req, res) => {
    try {
      const { status, note } = req.body;

      await applications.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status, statusNote: note || "" } }
      );

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false });
    }
  }
);

// DELETE
app.delete("/admin/application/:id", ensureDB, adminAuth, async (req, res) => {
  try {
    await applications.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* ----------------------------------------------------------
   ROLE CHECK
---------------------------------------------------------- */
app.get("/auth/role", ensureDB, authMiddleware, (req, res) => {
  try {
    if (req.isAdmin) return res.json({ success: true, role: "admin" });

    if (req.isConductor) return res.json({ success: true, role: "conductor" });

    return res.json({ success: true, role: "user" });
  } catch {
    return res.status(500).json({ success: false });
  }
});

// REDIRECT DASHBOARD
app.get("/dashboard", (req, res) => {
  const token = getToken(req);
  if (!token) return res.redirect("/login.html");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.isAdmin) return res.redirect("/admin/dashboard.html");

    return res.redirect("/index.html");
  } catch {
    return res.redirect("/login.html");
  }
});

/* ----------------------------------------------------------
   ⭐ NEW ROUTE — Get Latest Ticket by Pass ID
---------------------------------------------------------- */
app.get("/latestTicket/:passId", ensureDB, async (req, res) => {
  try {
    const passId = req.params.passId;

    const applicant = await applications.findOne({ passId });
    if (!applicant)
      return res
        .status(404)
        .json({ success: false, msg: "Applicant not found" });

    const latest = await tickets
      .find({ "passenger.passId": passId })
      .sort({ bookedAt: -1 })
      .limit(1)
      .toArray();

    if (!latest.length)
      return res.json({ success: false, msg: "No tickets found" });

    res.json({
      success: true,
      applicant,
      ticket: latest[0],
    });
  } catch (err) {
    console.error("Latest Ticket Error:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ CONDUCTOR LIVE LOCATION UPDATE (WITH TRACKING FLAG)
   - fixed lat/lng presence check (allow 0)
---------------------------------------------------------- */
app.post(
  "/updateLocation",
  ensureDB,
  conductorAuth,
  async (req, res) => {
    try {
      const { lat, lng, busNo } = req.body;

      // allow 0 lat/lng, only check undefined/null
      if (lat === undefined || lng === undefined || !busNo) {
        return res.json({ success: false, msg: "Missing lat/lng/busNo" });
      }

      await conductors.updateOne(
        { _id: new ObjectId(req.conductorId) },
        {
          $set: {
            location: { lat, lng },
            busNo: String(busNo).toUpperCase(),
            trackingEnabled: true,
            updatedAt: new Date(),
          },
        }
      );

      res.json({ success: true, msg: "Location updated" });
    } catch (err) {
      console.error("Location Update Error:", err);
      res.status(500).json({ success: false });
    }
  }
);

/* ----------------------------------------------------------
   ⭐ DISABLE TRACKING
---------------------------------------------------------- */
app.post(
  "/disableTracking",
  ensureDB,
  conductorAuth,
  async (req, res) => {
    try {
      await conductors.updateOne(
        { _id: new ObjectId(req.conductorId) },
        {
          $set: {
            trackingEnabled: false,
            location: null,
          },
        }
      );

      res.json({ success: true, msg: "Tracking disabled" });
    } catch (err) {
      console.error("Disable Tracking Error:", err);
      res.status(500).json({ success: false });
    }
  }
);

/* ----------------------------------------------------------
   ⭐ LIVE SEAT COUNT FOR CONDUCTOR BUS (5 SEATS)
---------------------------------------------------------- */
app.get("/conductor/seats", ensureDB, conductorAuth, async (req, res) => {
  try {
    const conductor = await conductors.findOne({
      _id: new ObjectId(req.conductorId),
    });

    if (!conductor || !conductor.busNo) {
      return res.json({ success: false, msg: "Bus number not set" });
    }
    const busNo = String(conductor.busNo).toUpperCase();  
    // fetch all tickets for this bus (for today or entire day)
const today = new Date().toISOString().slice(0,10);
const allTickets = await tickets.find({ busNo, journeyDate: today }).toArray();

    const stats = calculateSeatStats(allTickets);

    res.json({
      success: true,
      busNo,
      totalCapacity: 10,

      totalPassengers: stats.totalPassengers,

      sittingUsed: stats.sittingUsed,
      standingUsed: stats.standingUsed,

      sittingLeft: stats.sittingLeft,
      standingLeft: stats.standingLeft,

      status: stats.status,

      stops: ROUTE_STOPS
    });

  } catch (err) {
    console.error("Seat Calculation Error:", err);
    res.status(500).json({ success: false, msg: "Internal server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ BUS INFO → Bus Number + Passenger Count (Today)
---------------------------------------------------------- */
app.get("/conductor/passengerCount", ensureDB, conductorAuth, async (req, res) => {
  try {
    const cond = await conductors.findOne({ _id: new ObjectId(req.conductorId) });

    if (!cond || !cond.busNo) {
      return res.json({
        success: false,
        msg: "Bus not assigned",
        count: 0
      });
    }

    const busNo = String(cond.busNo).trim().toUpperCase();
    const today = new Date().toISOString().slice(0, 10);

    const count = await tickets.countDocuments({
      busNo,
      journeyDate: today
    });

    res.json({
      success: true,
      busNo,
      count
    });

  } catch (e) {
    console.error("Passenger Count Error:", e);
    res.json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ PUBLIC BUS INFO — Passenger Count + Sitting/Standing Status
   Used by livebus.html when searching bus number
---------------------------------------------------------- */
app.get("/businfo/:busNo", ensureDB, async (req, res) => {
  try {
    const busNo = String(req.params.busNo || "").trim().toUpperCase();
    if (!busNo) return res.json({ success: false, msg: "Bus number missing" });

    // Fetch TODAY’S tickets only
    const today = new Date().toISOString().slice(0, 10);
    const allTickets = await tickets.find({
      busNo,
      journeyDate: today
    }).toArray();

    // Calculate seat status
    const stats = calculateSeatStats(allTickets);

    res.json({
      success: true,
      busNo,
      totalPassengers: stats.totalPassengers,

      sittingUsed: stats.sittingUsed,
      standingUsed: stats.standingUsed,

      sittingLeft: stats.sittingLeft,
      standingLeft: stats.standingLeft,

      status: stats.status
    });

  } catch (err) {
    console.error("Bus Info Error:", err);
    res.json({ success: false, msg: "Server error" });
  }
});

/* ----------------------------------------------------------
   ⭐ GET BUS LOCATION BY BUS NUMBER (OPTION A LOGIC)
---------------------------------------------------------- */
app.get("/buslocation/:busNo", ensureDB, async (req, res) => {
  try {
    if (!conductors) {
      return res.json({
        success: false,
        tracking: false,
        msg: "Database not ready",
      });
    }

    // Normalize + validate bus number
    let busNo = String(req.params.busNo || "").trim().toUpperCase();
    if (!busNo) {
      return res.json({
        success: false,
        tracking: false,
        msg: "Bus number missing",
      });
    }

    // Find conductor by bus number
    const conductor = await conductors.findOne({ busNo });

    if (!conductor) {
      return res.json({
        success: false,
        tracking: false,
        msg: "Bus not found",
      });
    }

    if (!conductor.trackingEnabled) {
      return res.json({
        success: false,
        tracking: false,
        msg: "Tracking disabled for this bus",
      });
    }

    if (!conductor.location) {
      return res.json({
        success: false,
        tracking: true,
        msg: "No location yet from conductor",
      });
    }

    res.json({
      success: true,
      tracking: true,
      busNo,
      location: conductor.location,
      updatedAt: conductor.updatedAt,
    });

  } catch (err) {
    console.error("Fetch Bus Location Error:", err);
    res.status(500).json({ success: false });
  }
});


app.post("/conductor/setBus", ensureDB, conductorAuth, async (req, res) => {
  try {
    const { busNo } = req.body;

    if (!busNo) {
      return res.json({
        success: false,
        msg: "Bus number required"
      });
    }

    // ⭐ AUTO ENABLE TRACKING WHEN BUS IS SET
    await conductors.updateOne(
      { _id: new ObjectId(req.conductorId) },
      {
        $set: {
          busNo: String(busNo).toUpperCase(),
          trackingEnabled: true,   // ⭐ AUTO ENABLED
          location: null,
          updatedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      msg: `Bus updated and tracking enabled for ${busNo}`,
      trackingEnabled: true
    });

  } catch (err) {
    console.error("Set Bus Error:", err);
    res.status(500).json({ success: false, msg: "Internal server error" });
  }
});



/* ----------------------------------------------------------
   ⭐ REMOVE PASSENGER (Decrease Standing → then Sitting)
---------------------------------------------------------- */
app.post("/conductor/removePassenger", ensureDB, conductorAuth, async (req, res) => {
  try {
    // 1️⃣ Get conductor
    const conductor = await conductors.findOne({
      _id: new ObjectId(req.conductorId)
    });

    if (!conductor || !conductor.busNo) {
      return res.json({ success: false, msg: "Bus not assigned" });
    }

const busNo = String(conductor.busNo).trim().toUpperCase();

    // 2️⃣ Fetch all tickets for this bus
const list = await tickets.find({ busNo }).toArray();

    // 3️⃣ Calculate current stats
    const stats = calculateSeatStats(list);

    let { sittingUsed, standingUsed } = stats;

    // 4️⃣ Apply decrease rule
    if (standingUsed > 0) {
      standingUsed--;
    } else if (sittingUsed > 0) {
      sittingUsed--;
    } else {
      return res.json({ success: false, msg: "No passengers to remove" });
    }

    // 🔥 REMOVE ONE FAKE ENTRY FROM LAST TICKET (ONLY FOR TESTING)
    const lastTicket = await tickets.findOne({ busNo }, { sort: { bookedAt: -1 } });

    if (lastTicket) {
      await tickets.deleteOne({ _id: lastTicket._id });
    }

    // 5️⃣ Recalculate again AFTER deletion
    const updated = calculateSeatStats(
      await tickets.find({ busNo }).toArray()
    );

    return res.json({
      success: true,
      msg: "Passenger removed successfully",
      stats: updated
    });

  } catch (err) {
    console.error("Remove Passenger Error:", err);
    return res.json({
      success: false,
      msg: "Server error while removing passenger"
    });
  }
});


// ========================================================
// PUBLIC — LiveBus FETCH passenger count
// ========================================================
app.get("/bus/getCount", ensureDB, async (req, res) => {
  try {
    let busNo = req.query.busNo;

    // Strict validation
    if (!busNo || typeof busNo !== "string" || busNo.trim() === "") {
      return res.json({ success: false, msg: "Bus number missing" });
    }

    busNo = busNo.trim().toUpperCase();

    const data =
      (await buses.findOne({ busNo })) || {
        boarded: 0,
        exited: 0,
        currentCount: 0,
      };

    return res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.json({ success: false, msg: err.message });
  }
});

// ========================================================
// PRIVATE — People Counter updates counts
// ========================================================
app.post("/bus/updateCount", ensureDB, conductorAuth, async (req, res) => {
  try {
    const busNo = String(req.body.busNo || "").toUpperCase();
    const boarded = Number(req.body.boarded || 0);
    const exited = Number(req.body.exited || 0);

    await buses.updateOne(
      { busNo },
      {
        $inc: {
          boarded,
          exited,
          currentCount: boarded - exited
        }
      },
      { upsert: true }
    );

    res.json({ success: true, msg: "Count updated" });

  } catch (err) {
    console.error(err);
    res.json({ success: false, msg: err.message });
  }
});

// ----------------------------------------------------------
// ⭐ PUBLIC CONFIG (Frontend-safe)
// ----------------------------------------------------------
app.get("/config", (req, res) => {
  res.json({
    mapboxToken: process.env.MAPBOX_TOKEN || ""
  });
});



const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

app.post("/api/gemini/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Message required"
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${SMARTMOVE_SYSTEM_PROMPT}\n\nUser Question:\n${text}`
            }
          ]
        }
      ]
    });

    res.json({
      success: true,
      response: response.text
    });

  } catch (err) {
    console.error("🔥 GEMINI ERROR:", err);
    res.status(500).json({
      success: false,
      message: "SmartMove Bharat AI is currently unavailable"
    });
  }
});



/* ----------------------------------------------------------   
   START SERVER
---------------------------------------------------------- */
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

