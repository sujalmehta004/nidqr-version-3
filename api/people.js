const os = require('os');
const connectToDatabase = require('../lib/db');
const Person = require('../lib/models/Person');
const Config = require('../lib/models/Config');
const AllowedComputer = require('../lib/models/AllowedComputer');

async function resolveDeviceInfo(req, data = {}) {
  let compName = String(
    data.computerName ||
    req.headers['x-client-computer-name'] ||
    req.headers['x-computer-name'] ||
    req.headers['x-device-name'] ||
    ''
  ).trim();

  let nick = String(
    data.nickname ||
    req.headers['x-client-nickname'] ||
    req.headers['x-device-nickname'] ||
    req.headers['x-nickname'] ||
    ''
  ).trim();

  // If computerName is not provided in data or headers, try OS hostname
  if (!compName) {
    try {
      compName = (os.hostname() || '').trim();
    } catch (e) {}
  }

  // If nickname is not provided, look it up from AllowedComputer collection
  if (compName && !nick) {
    try {
      const match = await AllowedComputer.findOne({
        computerName: { $regex: new RegExp(`^${compName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      });
      if (match && match.nickname) {
        nick = String(match.nickname).trim();
      }
    } catch (e) {}
  }

  return { computerName: compName, nickname: nick };
}

// ─── UPDATE MODE CONSTANTS ──────────────────────────────────────────────────
//
// TOKEN-ONLY mode: triggered when the update comes from an automated process
// (PDF download, QR scan, token paste, public verify page). In this mode ONLY
// the 'token' field is written to the database. Every identity field
// (name, address, mobile, DOB, NID number, etc.) is completely immutable and
// CANNOT be changed or overwritten — not even with an empty string.
//
// MANUAL EDIT mode: triggered when an admin submits the workspace edit form.
// All fields are editable, full diff-based history is recorded, and a
// previous snapshot is saved so changes can always be reviewed.
//
// Mode is detected by the 'updateAction' field in the request body:
//   'Token Verified & Saved' (or similar) → TOKEN-ONLY
//   Anything else                         → MANUAL EDIT

const TOKEN_ONLY_ACTIONS = new Set([
  'token verified & saved',
  'token verified and saved',
]);

// All fields tracked in change history.
const TRACKED_FIELDS = [
  'ninEn', 'ninNp', 'givenEn', 'givenNp', 'surnameEn', 'surnameNp',
  'dobEn', 'dobNp', 'nationality', 'citDate', 'status', 'cardDesign',
  'addressEn', 'addressNp', 'baseUrl', 'token', 'mobile',
];

const BACKUP_IMPORT_FIELDS = [
  'ninEn', 'ninNp', 'givenEn', 'givenNp', 'surnameEn', 'surnameNp',
  'dobEn', 'dobNp', 'nationality', 'citDate', 'downloadDate', 'regDate',
  'updateDate', 'status', 'addressEn', 'addressNp', 'baseUrl', 'token',
  'mobile', 'cardDesign', 'computerName', 'nickname', 'updatedComputerName',
  'updatedNickname', 'alert', 'updateHistory',
];
const BACKUP_IGNORED_METADATA = new Set(['_id', '__v', 'createdAt', 'updatedAt']);

const BACKUP_FIELD_LABELS = {
  ninEn: 'NIN (English)',
  ninNp: 'NIN (Nepali)',
  givenEn: 'Given name (English)',
  givenNp: 'Given name (Nepali)',
  surnameEn: 'Surname (English)',
  surnameNp: 'Surname (Nepali)',
  dobEn: 'Date of birth (English)',
  dobNp: 'Date of birth (Nepali)',
  nationality: 'Nationality',
  citDate: 'Citizenship date',
  downloadDate: 'Download date',
  regDate: 'Registration date',
  updateDate: 'Update date',
  status: 'Status',
  addressEn: 'Address (English)',
  addressNp: 'Address (Nepali)',
  baseUrl: 'Base URL',
  token: 'e-NID token',
  mobile: 'Mobile number',
  cardDesign: 'Card design',
  computerName: 'Computer name',
  nickname: 'Nickname',
  updatedComputerName: 'Updated computer name',
  updatedNickname: 'Updated nickname',
  alert: 'Alert settings',
  updateHistory: 'Update history',
};

function backupComparableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(backupComparableValue);
  if (value && typeof value === 'object') {
    const source = typeof value.toObject === 'function' ? value.toObject() : value;
    return Object.keys(source).sort().reduce((result, key) => {
      if (key !== '_id' && key !== '__v') result[key] = backupComparableValue(source[key]);
      return result;
    }, {});
  }
  return value == null ? null : value;
}

function formatBackupValue(value) {
  if (value == null || value === '') return '(empty)';
  if (typeof value === 'object') return JSON.stringify(backupComparableValue(value));
  return String(value);
}

async function prepareBackupImport(records) {
  if (!Array.isArray(records)) {
    const error = new Error('Backup JSON must contain an array of person records.');
    error.statusCode = 400;
    throw error;
  }

  const groupedByNin = new Map();
  const parsed = records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { index, record, candidate: null, error: 'Record must be a JSON object.' };
    }
    const candidate = {};
    for (const field of BACKUP_IMPORT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(record, field)) candidate[field] = record[field];
    }
    const unsupportedFields = Object.keys(record).filter(
      field => !BACKUP_IMPORT_FIELDS.includes(field) && !BACKUP_IGNORED_METADATA.has(field)
    );
    let error = unsupportedFields.length
      ? `Unsupported field(s): ${unsupportedFields.slice(0, 10).join(', ')}.`
      : '';
    if (Object.prototype.hasOwnProperty.call(candidate, 'ninEn') && typeof candidate.ninEn !== 'string') {
      error = `${error ? `${error} ` : ''}NIN (English) must be a string.`;
    }
    const nin = typeof candidate.ninEn === 'string' ? candidate.ninEn.trim() : '';
    if (nin) {
      candidate.ninEn = nin;
      if (!groupedByNin.has(nin)) groupedByNin.set(nin, []);
      groupedByNin.get(nin).push(index);
    }
    return { index, record, candidate, error };
  });

  const duplicateIndexes = new Set();
  for (const indexes of groupedByNin.values()) {
    if (indexes.length > 1) indexes.forEach(index => duplicateIndexes.add(index));
  }

  for (const entry of parsed) {
    if (entry.error || duplicateIndexes.has(entry.index)) continue;
    try {
      await new Person(entry.candidate).validate();
    } catch (error) {
      entry.error = Object.values(error.errors || {})
        .map(item => item.message)
        .join('; ') || error.message || 'Record validation failed.';
    }
  }

  const validNins = parsed
    .filter(entry => entry.candidate && entry.candidate.ninEn && !entry.error && !duplicateIndexes.has(entry.index))
    .map(entry => entry.candidate.ninEn);
  const existingRecords = validNins.length
    ? await Person.find({ ninEn: { $in: validNins } }).lean()
    : [];
  const existingByNin = new Map(existingRecords.map(person => [person.ninEn, person]));
  const report = {
    totals: {
      input: records.length,
      new: 0,
      changed: 0,
      unchanged: 0,
      duplicate: duplicateIndexes.size,
      invalid: 0,
      fieldsToReplace: 0,
    },
    newRecords: [],
    changedRecords: [],
    unchangedRecords: [],
    duplicateRecords: [],
    invalidRecords: [],
  };

  for (const entry of parsed) {
    const record = entry.record || {};
    const personName = [record.givenEn, record.surnameEn].filter(Boolean).join(' ') || '(Name missing)';
    const item = {
      index: entry.index + 1,
      nin: entry.candidate && entry.candidate.ninEn || String(record.ninEn || ''),
      name: personName,
    };
    if (duplicateIndexes.has(entry.index)) {
      report.duplicateRecords.push({ ...item, reason: 'NIN appears more than once in this backup.' });
      continue;
    }
    if (entry.error || !entry.candidate || !entry.candidate.ninEn) {
      report.totals.invalid++;
      report.invalidRecords.push({
        ...item,
        reason: entry.error || 'NIN (English) is required.',
      });
      continue;
    }

    const existing = existingByNin.get(entry.candidate.ninEn);
    if (!existing) {
      report.totals.new++;
      report.newRecords.push(item);
      continue;
    }

    const changes = [];
    for (const field of Object.keys(entry.candidate)) {
      const before = backupComparableValue(existing[field]);
      const after = backupComparableValue(entry.candidate[field]);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({
          field,
          label: BACKUP_FIELD_LABELS[field] || field,
          before: formatBackupValue(existing[field]),
          after: formatBackupValue(entry.candidate[field]),
        });
      }
    }
    if (changes.length) {
      report.totals.changed++;
      report.totals.fieldsToReplace += changes.length;
      report.changedRecords.push({ ...item, changes });
    } else {
      report.totals.unchanged++;
      report.unchangedRecords.push(item);
    }
  }
  return { report, parsed };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function detectTokenOnly(data) {
  const action = String(data.updateAction || '').trim().toLowerCase();
  return TOKEN_ONLY_ACTIONS.has(action) || data._tokenOnly === true;
}

function diffFields(existingPerson, data) {
  const changedFields = [];
  const fieldChanges = {};
  const previousSnapshot = {};
  for (const field of TRACKED_FIELDS) {
    const oldVal = existingPerson[field] != null ? String(existingPerson[field]).trim() : '';
    previousSnapshot[field] = oldVal;
    if (data[field] != null) {
      let newVal = String(data[field]).trim();
      if (field === 'givenEn' || field === 'surnameEn' || field === 'nationality') newVal = newVal.toUpperCase();
      if (newVal !== '' && newVal !== oldVal) {
        changedFields.push(field);
        fieldChanges[field] = { from: oldVal, to: newVal };
      }
    }
  }
  return { changedFields, fieldChanges, previousSnapshot };
}

const FIELD_FRIENDLY_NAMES = {
  mobile: 'Mobile Number',
  addressEn: 'Address (EN)',
  addressNp: 'Address (NP)',
  givenEn: 'Given Name (EN)',
  surnameEn: 'Surname (EN)',
  givenNp: 'Given Name (NP)',
  surnameNp: 'Surname (NP)',
  dobEn: 'DOB (EN)',
  dobNp: 'DOB (NP)',
  nationality: 'Nationality',
  citDate: 'Citizenship Date',
  status: 'Status',
  cardDesign: 'Card Design',
  ninEn: 'NIN (EN)',
  ninNp: 'NIN (NP)',
  token: 'e-NID Token',
  baseUrl: 'Base URL',
};

function buildActionLabel(data, changedFields) {
  if (data.updateAction && data.updateAction.trim() !== '') {
    // If updateAction is passed as "Token Verified & Saved" but token is NOT among changedFields, override it!
    const isTokenAction = data.updateAction.toLowerCase().includes('token');
    const hasTokenChanged = changedFields.includes('token');
    if (!isTokenAction || hasTokenChanged) {
      return data.updateAction;
    }
  }

  if (!changedFields || changedFields.length === 0) return 'Manual Edit';

  // Single field updates
  if (changedFields.length === 1) {
    const f = changedFields[0];
    if (f === 'mobile') return 'Mobile Number Updated';
    if (f === 'status') return `Status Changed: ${data.status || 'Updated'}`;
    if (f === 'cardDesign') return `Card Design: ${data.cardDesign || 'Updated'}`;
    if (f === 'token') return 'Token Verified & Saved';
    if (f === 'addressEn' || f === 'addressNp') return 'Address Updated';
    if (f === 'givenEn' || f === 'surnameEn') return 'English Name Updated';
    if (f === 'givenNp' || f === 'surnameNp') return 'Nepali Name Updated';
    if (f === 'dobEn' || f === 'dobNp') return 'Date of Birth Updated';
    if (f === 'citDate') return 'Citizenship Date Updated';
    if (f === 'ninEn' || f === 'ninNp') return 'NIN Updated';
    const friendly = FIELD_FRIENDLY_NAMES[f] || f;
    return `${friendly} Updated`;
  }

  // Two related fields
  const set = new Set(changedFields);
  if (set.size === 2) {
    if (set.has('givenEn') && set.has('surnameEn')) return 'English Name Updated';
    if (set.has('givenNp') && set.has('surnameNp')) return 'Nepali Name Updated';
    if (set.has('addressEn') && set.has('addressNp')) return 'Address (EN & NP) Updated';
    if (set.has('dobEn') && set.has('dobNp')) return 'Date of Birth Updated';
    if (set.has('token') && set.has('status')) return 'Token Verified & Saved';
    if (set.has('token') && set.has('mobile')) return 'Token & Mobile Number Updated';
  }

  // Multiple fields with token
  if (changedFields.includes('token')) {
    const others = changedFields.filter(f => f !== 'token').map(f => FIELD_FRIENDLY_NAMES[f] || f);
    if (others.length <= 2) {
      return `Token & ${others.join(', ')} Updated`;
    }
    return `Token & Profile Updated (${others.length} fields)`;
  }

  // Multiple profile fields without token
  const labels = changedFields.map(f => FIELD_FRIENDLY_NAMES[f] || f);
  if (labels.length <= 3) {
    return `${labels.join(', ')} Updated`;
  }
  return `Profile Updated (${labels.length} fields: ${labels.slice(0, 3).join(', ')}...)`;
}

function pushHistory(existingPerson, entry) {
  if (!existingPerson.updateHistory) existingPerson.updateHistory = [];
  existingPerson.updateHistory.push(entry);
  if (existingPerson.updateHistory.length > 100) {
    existingPerson.updateHistory = existingPerson.updateHistory.slice(-100);
  }
}

function applyManualFields(existingPerson, data) {
  // Identity fields that must not be cleared with an empty string.
  const PROTECTED = new Set([
    'givenEn', 'surnameEn', 'givenNp', 'surnameNp',
    'addressEn', 'addressNp', 'mobile', 'dobEn', 'dobNp', 'ninNp',
  ]);
  // Internal / meta fields that the loop must never touch.
  const SKIP = new Set([
    '_id', 'updateHistory', 'updateAction', 'updateNote', '_tokenOnly',
    'createdAt', 'updatedAt', 'alert',
  ]);
  Object.keys(data).forEach(key => {
    if (SKIP.has(key)) return;
    const val = data[key];
    const str = typeof val === 'string' ? val.trim() : '';
    // Guard: never blank-out a protected field that already has a real value.
    if (PROTECTED.has(key) && str === '') {
      const existing = existingPerson[key];
      if (existing != null && String(existing).trim() !== '') return;
    }
    if (key === 'givenEn' || key === 'surnameEn' || key === 'nationality') {
      existingPerson[key] = typeof val === 'string' ? str.toUpperCase() : val;
    } else if (typeof val === 'string') {
      existingPerson[key] = str;
    } else {
      existingPerson[key] = val;
    }
  });
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (typeof res.status !== 'function') {
    res.status = function (s) { this.statusCode = s; return this; };
  }
  if (typeof res.json !== 'function') {
    res.json = function (d) {
      this.setHeader('Content-Type', 'application/json');
      this.end(JSON.stringify(d));
      return this;
    };
  }
  if (typeof res.send !== 'function') {
    res.send = function (d) { this.end(d); return this; };
  }

  try {
    await connectToDatabase();
  } catch (error) {
    console.error('Database connection error:', error);
    return res.status(500).json({ error: 'Database connection failed' });
  }

  const { method } = req;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') return res.status(200).end();

  switch (method) {

    // ── GET ───────────────────────────────────────────────────────────────────
    case 'GET':
      try {
        const { query, status, regStart, regPeriod, clientDate, sortBy, sortOrder } = req.query;
        const filter = {};

        if (status && status !== 'all') filter.status = status;

        if (regPeriod && regPeriod !== 'all') {
          let baseDate = new Date();
          if (clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate)) {
            const [y, m, d] = clientDate.split('-').map(Number);
            baseDate = new Date(y, m - 1, d);
          }
          const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const today = fmt(baseDate);
          if (regPeriod === 'today') {
            filter.regDate = today;
          } else if (regPeriod === 'yesterday') {
            const y = new Date(baseDate); y.setDate(baseDate.getDate() - 1);
            filter.regDate = fmt(y);
          } else if (regPeriod === 'this_week') {
            const s = new Date(baseDate); s.setDate(baseDate.getDate() - baseDate.getDay());
            filter.regDate = { $gte: fmt(s), $lte: today };
          } else if (regPeriod === 'this_month') {
            filter.regDate = { $gte: `${today.substring(0, 8)}01`, $lte: today };
          } else if (regPeriod === 'this_year') {
            filter.regDate = { $gte: `${today.substring(0, 5)}01-01`, $lte: today };
          }
        } else if (regStart) {
          filter.regDate = { $gte: regStart };
        }

        if (query) {
          const re = new RegExp(query.trim(), 'i');
          filter.$or = [
            { ninEn: re }, { ninNp: re }, { givenEn: re }, { surnameEn: re },
            { givenNp: re }, { surnameNp: re }, { addressEn: re }, { addressNp: re },
          ];
        }

        let sort = {};
        if (sortBy) {
          const order = sortOrder === 'asc' ? 1 : -1;
          sort = sortBy === 'name' ? { givenEn: order, surnameEn: order } : { [sortBy]: order };
        } else {
          sort = { createdAt: -1, _id: -1 };
        }

        const list = await Person.find(filter).sort(sort);
        return res.status(200).json(list);
      } catch (err) {
        return res.status(500).json({ error: 'Failed to retrieve records', details: err.message });
      }

    // ── POST (create new record) ──────────────────────────────────────────────
    case 'POST':
      try {
        const data = req.body || {};
        if (data.action === 'preview-backup-import' || data.action === 'apply-backup-import') {
          const config = await Config.findOne({ key: 'default' });
          const expectedPassword = config && String(config.adminUnlockPassword || '').trim()
            ? String(config.adminUnlockPassword).trim()
            : 'admin12345';
          if (String(data.adminPassword || '') !== expectedPassword) {
            return res.status(403).json({ error: 'Unauthorized: Invalid admin password' });
          }

          const { report, parsed } = await prepareBackupImport(data.records);
          if (data.action === 'preview-backup-import') {
            return res.status(200).json({ report });
          }

          const totals = { added: 0, replaced: 0, unchanged: 0, skipped: 0, failed: 0 };
          const failures = [];
          const duplicateIndexes = new Set(report.duplicateRecords.map(item => item.index - 1));
          const deviceInfo = await resolveDeviceInfo(req, data);
          for (const entry of parsed) {
            if (
              entry.error ||
              !entry.candidate ||
              !entry.candidate.ninEn ||
              duplicateIndexes.has(entry.index)
            ) {
              continue;
            }

            try {
              const existingPerson = await Person.findOne({ ninEn: entry.candidate.ninEn });
              if (existingPerson) {
                const changes = Object.keys(entry.candidate).some(field =>
                  JSON.stringify(backupComparableValue(existingPerson[field])) !==
                  JSON.stringify(backupComparableValue(entry.candidate[field]))
                );
                if (!changes) {
                  totals.unchanged++;
                  continue;
                }
                existingPerson.set(entry.candidate);
                await existingPerson.save();
                totals.replaced++;
              } else {
                const newPerson = new Person({
                  ...entry.candidate,
                  computerName: entry.candidate.computerName || deviceInfo.computerName,
                  nickname: entry.candidate.nickname || deviceInfo.nickname,
                });
                await newPerson.save();
                totals.added++;
              }
            } catch (error) {
              totals.failed++;
              failures.push({
                nin: entry.candidate.ninEn,
                name: [entry.candidate.givenEn, entry.candidate.surnameEn].filter(Boolean).join(' '),
                error: error.message,
              });
              console.error(`Backup import failed for ${entry.candidate.ninEn}:`, error);
            }
          }
          totals.skipped += report.totals.invalid + report.totals.duplicate;
          return res.status(200).json({
            message: 'Backup import completed.',
            totals,
            failures: failures.slice(0, 50),
          });
        }

        if (data.action === 'rollback-latest-update-all') {
          const config = await Config.findOne({ key: 'default' });
          const expectedPassword = config && String(config.adminUnlockPassword || '').trim()
            ? String(config.adminUnlockPassword).trim()
            : 'admin12345';
          if (String(data.adminPassword || '') !== expectedPassword) {
            return res.status(403).json({ error: 'Unauthorized: Invalid admin password' });
          }

          const deviceInfo = await resolveDeviceInfo(req, data);
          const totals = { scanned: 0, reversed: 0, skipped: 0, failed: 0 };
          const failures = [];
          const cursor = Person.find({}).cursor();

          for await (const person of cursor) {
            totals.scanned++;
            const history = Array.isArray(person.updateHistory) ? person.updateHistory : [];
            if (!history.length) {
              totals.skipped++;
              continue;
            }

            let latestIndex = history.length - 1;
            let latestTimestamp = Number.NEGATIVE_INFINITY;
            history.forEach((entry, index) => {
              const timestamp = entry.updatedAt ? new Date(entry.updatedAt).getTime() : Number.NaN;
              if (Number.isFinite(timestamp) && timestamp >= latestTimestamp) {
                latestTimestamp = timestamp;
                latestIndex = index;
              }
            });
            const latestEntry = history[latestIndex];
            const action = String(latestEntry.action || '').trim();
            const changedFields = Array.isArray(latestEntry.changedFields)
              ? [...new Set(latestEntry.changedFields.map(field => String(field).trim()))]
              : [];
            const changes = {};
            let canReverse = changedFields.length > 0 && !/^record created$/i.test(action);

            for (const field of changedFields) {
              if (!TRACKED_FIELDS.includes(field)) {
                canReverse = false;
                break;
              }
              const change = latestEntry.changes && latestEntry.changes[field];
              if (!change || !Object.prototype.hasOwnProperty.call(change, 'from') ||
                  !Object.prototype.hasOwnProperty.call(change, 'to')) {
                canReverse = false;
                break;
              }
              const currentValue = person[field] == null ? '' : String(person[field]).trim();
              const recordedValue = change.to == null ? '' : String(change.to).trim();
              if (currentValue !== recordedValue) {
                canReverse = false;
                break;
              }
              changes[field] = {
                from: person[field] == null ? '' : String(person[field]).trim(),
                to: change.from == null ? '' : String(change.from).trim()
              };
            }

            if (!canReverse) {
              totals.skipped++;
              continue;
            }

            if (Object.prototype.hasOwnProperty.call(changes, 'ninEn') && changes.ninEn.to) {
              const duplicate = await Person.exists({ ninEn: changes.ninEn.to, _id: { $ne: person._id } });
              if (duplicate) {
                totals.skipped++;
                continue;
              }
            }

            const snapshot = {};
            changedFields.forEach((field) => {
              snapshot[field] = person[field] == null ? '' : String(person[field]).trim();
              person[field] = changes[field].to;
            });
            const now = new Date();
            person.updatedComputerName = deviceInfo.computerName;
            person.updatedNickname = deviceInfo.nickname;
            person.updateDate = now.toISOString().split('T')[0];
            pushHistory(person, {
              updatedAt: now,
              updateDate: person.updateDate,
              action: 'Previous Update Reversed',
              note: `Reversed the latest recorded update${action ? `: ${action}` : ''}.`,
              computerName: deviceInfo.computerName,
              nickname: deviceInfo.nickname,
              changedFields,
              changes,
              snapshot
            });

            try {
              await person.save();
              totals.reversed++;
            } catch (error) {
              totals.failed++;
              failures.push({ nin: String(person.ninEn || ''), error: error.message });
              console.error(`Failed to reverse the latest update for ${person.ninEn || person._id}:`, error);
            }
          }

          return res.status(200).json({
            message: 'Bulk history rollback completed.',
            totals,
            failures: failures.slice(0, 20)
          });
        }

        if (!data.ninEn || !data.givenEn || !data.surnameEn) {
          return res.status(400).json({ error: 'NIN (English), Given Name, and Surname are required fields' });
        }
        const existing = await Person.findOne({ ninEn: data.ninEn });
        if (existing) {
          return res.status(409).json({ error: `A record with NIN '${data.ninEn}' already exists in the database.` });
        }

        const deviceInfo = await resolveDeviceInfo(req, data);
        data.computerName = deviceInfo.computerName;
        data.nickname = deviceInfo.nickname;
        data.updatedComputerName = deviceInfo.computerName;
        data.updatedNickname = deviceInfo.nickname;

        if (!Array.isArray(data.updateHistory) || data.updateHistory.length === 0) {
          const deviceLabel = deviceInfo.nickname
            ? `${deviceInfo.nickname} (${deviceInfo.computerName})`
            : (deviceInfo.computerName || 'Device');
          data.updateHistory = [{
            updatedAt: new Date(),
            updateDate: data.regDate || new Date().toISOString().split('T')[0],
            action: 'Record Created',
            note: `New record created on ${deviceLabel}`,
            computerName: deviceInfo.computerName,
            nickname: deviceInfo.nickname,
            changedFields: Object.keys(data).filter(k => !['_id', 'updateHistory'].includes(k)),
            changes: {},
            snapshot: {
              ninEn: data.ninEn,
              givenEn: data.givenEn,
              surnameEn: data.surnameEn,
              status: data.status || 'done'
            }
          }];
        }

        const newPerson = new Person(data);
        await newPerson.save();
        return res.status(201).json(newPerson);
      } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Duplicate key error: This NIN is already registered.' });
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        return res.status(500).json({ error: 'Failed to save record', details: err.message });
      }

    // ── PUT (update) ──────────────────────────────────────────────────────────
    case 'PUT':
      try {
        const { originalNin } = req.query;
        const data = req.body;

        if (!originalNin) {
          return res.status(400).json({ error: 'Original NIN parameter is required to update a record' });
        }

        const existingPerson = await Person.findOne({ ninEn: originalNin });
        if (!existingPerson) {
          return res.status(404).json({ error: 'Record not found to update' });
        }

        const deviceInfo = await resolveDeviceInfo(req, data);
        existingPerson.updatedComputerName = deviceInfo.computerName;
        existingPerson.updatedNickname = deviceInfo.nickname;
        if (!existingPerson.computerName) {
          existingPerson.computerName = deviceInfo.computerName;
          existingPerson.nickname = deviceInfo.nickname;
        }

        const tokenOnly = detectTokenOnly(data);

        // ══════════════════════════════════════════════════════════════════════
        // TOKEN-ONLY MODE
        // ─ Triggered by: PDF download, QR scan, token paste, public verify page
        // ─ ONLY 'token' field is written to the database
        // ─ ALL other fields are completely ignored — they cannot be overwritten
        // ─ Status is auto-set to 'done' when a valid token is saved
        // ══════════════════════════════════════════════════════════════════════
        if (tokenOnly) {
          const newToken = typeof data.token === 'string' ? data.token.trim() : '';
          if (!newToken) {
            return res.status(400).json({ error: 'Token-only update requires a non-empty token value.' });
          }

          const oldToken = String(existingPerson.token || '').trim();
          const tokenChanged = newToken !== oldToken;

          if (tokenChanged) {
            pushHistory(existingPerson, {
              updatedAt: new Date(),
              updateDate: data.updateDate || new Date().toISOString().split('T')[0],
              action: 'Token Verified & Saved',
              note: data.updateNote || 'Token updated from scanned/extracted PDF QR code',
              computerName: deviceInfo.computerName,
              nickname: deviceInfo.nickname,
              changedFields: ['token'],
              changes: { token: { from: oldToken, to: newToken } },
              snapshot: {
                ninEn: String(existingPerson.ninEn || ''),
                givenEn: String(existingPerson.givenEn || ''),
                surnameEn: String(existingPerson.surnameEn || ''),
                givenNp: String(existingPerson.givenNp || ''),
                surnameNp: String(existingPerson.surnameNp || ''),
                mobile: String(existingPerson.mobile || ''),
                addressEn: String(existingPerson.addressEn || ''),
                token: oldToken,
                status: String(existingPerson.status || ''),
              },
            });

            // STRICT: only write the token field
            existingPerson.token = newToken;
          }

          // Always stamp status=done and updateDate when a valid token is saved
          existingPerson.status = 'done';
          existingPerson.updateDate = data.updateDate || new Date().toISOString().split('T')[0];

          await existingPerson.save();
          return res.status(200).json({ ...existingPerson.toObject(), _updateMode: 'token-only', _tokenChanged: tokenChanged });
        }

        // ══════════════════════════════════════════════════════════════════════
        // MANUAL EDIT MODE
        // ─ Triggered by: admin form workspace submissions
        // ─ All fields are editable
        // ─ Full diff-based history is always recorded before changes are applied
        // ─ Identity fields cannot be cleared with empty strings (must supply a
        //   real replacement value)
        // ══════════════════════════════════════════════════════════════════════

        // Guard against NIN collision when changing NID number
        if (data.ninEn && data.ninEn !== originalNin) {
          const duplicate = await Person.findOne({ ninEn: data.ninEn });
          if (duplicate) {
            return res.status(409).json({ error: `Cannot update. NIN '${data.ninEn}' is already assigned to another record.` });
          }
        }

        // Compute field diff and record history
        const { changedFields, fieldChanges, previousSnapshot } = diffFields(existingPerson, data);

        const hasAlertUpdate = data.alert !== undefined;
        if (hasAlertUpdate) {
          existingPerson.alert = {
            enabled: Boolean(data.alert && data.alert.enabled),
            message: data.alert && typeof data.alert.message === 'string' ? data.alert.message.trim() : '',
            allowUse: Boolean(data.alert && data.alert.allowUse),
            shopPhone: data.alert && typeof data.alert.shopPhone === 'string' ? data.alert.shopPhone.trim() : '',
            updatedAt: new Date(),
          };
        }

        if (changedFields.length > 0 || hasAlertUpdate) {
          const actionText = data.updateAction || (hasAlertUpdate && changedFields.length === 0 ? (data.alert?.enabled ? 'Card Alert Configured' : 'Card Alert Cleared') : buildActionLabel(data, changedFields));
          const noteText = data.updateNote || (hasAlertUpdate && changedFields.length === 0 ? `Alert ${data.alert?.enabled ? `enabled (Usage: ${data.alert.allowUse ? 'Allowed' : 'Blocked'}): "${data.alert.message || ''}"` : 'cleared'}` : `Updated ${changedFields.length} field(s): ${changedFields.join(', ')}`);
          pushHistory(existingPerson, {
            updatedAt: new Date(),
            updateDate: data.updateDate || new Date().toISOString().split('T')[0],
            action: actionText,
            note: noteText,
            computerName: deviceInfo.computerName,
            nickname: deviceInfo.nickname,
            changedFields: changedFields.length > 0 ? changedFields : ['alert'],
            changes: fieldChanges,
            snapshot: previousSnapshot,
          });
        }

        // Apply changes with empty-string protection on identity fields
        applyManualFields(existingPerson, data);

        existingPerson.updateDate = data.updateDate || new Date().toISOString().split('T')[0];

        await existingPerson.save();
        return res.status(200).json({ ...existingPerson.toObject(), _updateMode: 'manual' });

      } catch (err) {
        return res.status(500).json({ error: 'Failed to update record', details: err.message });
      }

    // ── DELETE ────────────────────────────────────────────────────────────────
    case 'DELETE':
      try {
        const { nin } = req.query;
        if (!nin) return res.status(400).json({ error: 'NIN parameter is required for deletion' });
        const deleted = await Person.findOneAndDelete({ ninEn: nin });
        if (!deleted) return res.status(404).json({ error: 'Record not found' });
        return res.status(200).json({ message: 'Record deleted successfully', deleted });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to delete record', details: err.message });
      }

    default:
      res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
      return res.status(405).json({ error: `Method ${method} Not Allowed` });
  }
};
