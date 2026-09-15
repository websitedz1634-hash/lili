// netlify/functions/create-noest-order.js
//
// Called from admin.html (button "تأكيد وإرسال لـ Noest") to push a confirmed
// order to Noest Express and get back a tracking number.
//
//   POST /.netlify/functions/create-noest-order
//   body: the order object as stored in Firestore ("orders" collection),
//         plus an optional "stationCode" field (attached by admin.html from
//         the "رمز مكتب Noest" column on the pricing page).
//
// ── Setup ────────────────────────────────────────────────────────────────
// In Netlify: Site settings → Environment variables, add:
//   NOEST_API_TOKEN       "API Token" from your Noest merchant space
//   NOEST_GUID            "GUID" from your Noest merchant space
//   NOEST_AUTO_VALIDATE   "true" to also auto-confirm the parcel right after
//                          creating it (optional, default: off — the parcel
//                          is created as an editable draft that someone
//                          validates by hand from the Noest dashboard).
//
// ── IMPORTANT — please read before relying on this in production ─────────
// Noest does not publish a public API reference page; the endpoint and field
// names below are the ones consistently used across independent Noest
// integrations, but Noest can only confirm the exact contract for your own
// account (the reference sheet they hand out when you request API access).
// Before trusting this for real orders:
//   1. Send ONE real test order and check it actually appears in your Noest
//      dashboard ("Commandes" list) with the right client, phone, address
//      and amount.
//   2. If Noest rejects the request, the admin dashboard shows the raw error
//      message it returned — use it to adjust the field names in
//      buildNoestPayload() below to match Noest's own documentation.
//   3. Whatever happens, the "نسخ بيانات الطلبية" button in the admin
//      dashboard keeps working as a manual fallback, so no order is ever lost.

const NOEST_BASE = "https://app.noest-dz.com/api/public";

function productSummary(order) {
  if (Array.isArray(order.items) && order.items.length) {
    return order.items
      .map((it) => {
        const details = [it.color, it.size].filter(Boolean).join(" - ");
        return `${it.name}${details ? " (" + details + ")" : ""} x${it.qty || 1}`;
      })
      .join(", ");
  }
  if (order.product) {
    const details = [order.color, order.size].filter(Boolean).join(" - ");
    return `${order.product.name}${details ? " (" + details + ")" : ""} x${order.qty || 1}`;
  }
  return "Commande lilya_brannd";
}

function totalQuantity(order) {
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.reduce((s, it) => s + (it.qty || 1), 0);
  }
  return order.qty || 1;
}

function buildNoestPayload(order, credentials, stationCode) {
  const isStopDesk = order.deliv === "Stop Desk";

  const payload = {
    api_token: credentials.apiToken,
    user_guid: credentials.guid,
    reference: order.orderId || "",
    client: `${order.name || ""} ${order.lastname || ""}`.trim(),
    phone: order.phone,
    adresse: order.commune ? `${order.commune}, ${order.wilaya}` : order.wilaya || "",
    wilaya_id: order.wilayaCode,
    commune: order.commune || order.wilaya,
    montant: order.total, // COD amount = products + shipping
    remarque: "",
    produit: productSummary(order),
    type_id: 1, // 1 = normal delivery, 2 = exchange, 3 = pick-up (per Noest spec)
    poids: 1, // weight in kg — adjust if you sell heavy items
    quantite: totalQuantity(order),
    can_open: 1, // let the customer open the parcel before paying
    stop_desk: isStopDesk ? 1 : 0,
  };

  if (isStopDesk) {
    if (!stationCode) {
      const err = new Error("NO_STATION_CODE");
      err.code = "NO_STATION_CODE";
      throw err;
    }
    payload.station_code = stationCode; // e.g. "19A" — set per-wilaya on the pricing page
  }

  return payload;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiToken = process.env.NOEST_API_TOKEN;
  const guid = process.env.NOEST_GUID;
  if (!apiToken || !guid) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "NOEST_API_TOKEN / NOEST_GUID غير مضبوطين بعد في إعدادات Netlify (Site settings → Environment variables).",
      }),
    };
  }

  let order;
  try {
    order = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  order.orderId = order.id || order.orderId || "";

  const stationCode =
    order.stationCode || (order.office && order.office.stationCode) || null;

  let payload;
  try {
    payload = buildNoestPayload(order, { apiToken, guid }, stationCode);
  } catch (e) {
    if (e.code === "NO_STATION_CODE") {
      return {
        statusCode: 422,
        body: JSON.stringify({
          error: `لا يوجد "رمز مكتب Noest" مضبوط لولاية ${order.wilaya}. أضيفيه في لوحة التحكم من صفحة "أسعار التوصيل" (عمود رمز مكتب Noest، مثال: 19A)، أو استخدمي زر "نسخ بيانات الطلبية" لإدخالها يدويًا في لوحة Noest.`,
        }),
      };
    }
    throw e;
  }

  try {
    const createRes = await fetch(`${NOEST_BASE}/create/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const createData = await createRes.json().catch(() => ({}));

    if (!createRes.ok || createData.success === false) {
      return {
        statusCode: createRes.status || 502,
        body: JSON.stringify({
          error: createData.message || createData.error || "فشل إنشاء الطلبية في Noest.",
          raw: createData,
        }),
      };
    }

    const tracking =
      createData.tracking || createData.trackingNumber || createData.tracking_number || null;

    let validation = null;
    if (String(process.env.NOEST_AUTO_VALIDATE).toLowerCase() === "true" && tracking) {
      try {
        const valRes = await fetch(`${NOEST_BASE}/valider/commande`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_token: apiToken, user_guid: guid, tracking }),
        });
        validation = await valRes.json().catch(() => ({}));
      } catch (e) {
        validation = { error: e.message };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, tracking, create: createData, validation }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message || "تعذّر الاتصال بخادم Noest Express." }),
    };
  }
};
