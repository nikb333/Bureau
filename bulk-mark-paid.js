// Bulk mark orders as paid, except for specific unpaid list
// Run this in browser console on bureau-a04.pages.dev

const API = "https://bureau.nik-d88.workers.dev";

// List of line items that should REMAIN UNPAID (actual outstanding items with due dates)
const UNPAID_ITEMS = [
  { ref: "PO 196 (WeWork)", type: "Release" },        // 31 Jan 2026 - OVERDUE
  { ref: "PO 197 (WeWork)", type: "Release" },        // 31 Jan 2026 - OVERDUE
  { ref: "PO-191", type: "Release" },                 // 31 Jan 2026 - OVERDUE
  { ref: "PO-195 (WeWork)", type: "Release" },        // 31 Jan 2026 - OVERDUE
  { ref: "PO-199", type: "Release" },                 // 06 Feb 2026 - OVERDUE
  { ref: "PO-204 (CISCO)", type: "Deposit" },         // 23 Jan 2026 - OVERDUE
  { ref: "Thank You Cards", type: "Deposit" },        // 28 Jan 2026 - OVERDUE
  { ref: "PO-189 (Treasure Data)", type: "Release" }, // 28 Mar 2026
  { ref: "PO-201", type: "Release" },                 // 25 Mar 2026
  { ref: "PO-201", type: "Deposit" },                 // 25 Feb 2026
  { ref: "PO-203", type: "Release" },                 // 12 Apr 2026
  { ref: "PO-203", type: "Deposit" },                 // 01 Mar 2026
  { ref: "PO-206", type: "Release" },                 // 13 Mar 2026
  { ref: "PO-206", type: "Deposit" },                 // 25 Feb 2026
  { ref: "PO-212", type: "Release" },                 // 13 Mar 2026
  { ref: "PO-212", type: "Deposit" },                 // 25 Feb 2026
  { ref: "PO-213", type: "Release" },                 // 13 Mar 2026
  { ref: "PO-213", type: "Deposit" },                 // 25 Feb 2026
  { ref: "PO-214", type: "Release" },                 // 25 Mar 2026
  { ref: "PO-214", type: "Deposit" },                 // 25 Feb 2026
  { ref: "Silk Print, Photography", type: "Release" },// 28 Feb 2026
  { ref: "Tuesday V2 Doors (x6)", type: "Deposit" },  // 25 Feb 2026
];

async function bulkMarkPaid() {
  console.log("🔄 Fetching all orders...");

  // Fetch all orders
  const res = await fetch(`${API}/api/orders`);
  const data = await res.json();
  const orders = data.orders;

  console.log(`📋 Found ${orders.length} orders`);

  let updated = 0;
  let skipped = 0;

  for (const order of orders) {
    const shouldSkipDeposit = UNPAID_ITEMS.some(
      item => item.ref === order.ref && item.type === "Deposit"
    );
    const shouldSkipRelease = UNPAID_ITEMS.some(
      item => item.ref === order.ref && item.type === "Release"
    );
    const shouldSkipFullAmount = UNPAID_ITEMS.some(
      item => item.ref === order.ref && item.type === "Full Amount"
    );

    const updates = {};
    let hasUpdates = false;

    // Determine realistic paid date based on order data
    // Priority: 1) depositDue/releaseDue, 2) poDate, 3) created date, 4) fall back to 2024
    const getHistoricalDate = (dueDate, poDate, created) => {
      if (dueDate) return dueDate;
      if (poDate) {
        // Add ~60 days to PO date for deposit, ~120 days for release
        const d = new Date(poDate);
        return d.toISOString().slice(0, 10);
      }
      if (created) {
        const d = new Date(created);
        return d.toISOString().slice(0, 10);
      }
      return "2024-06-01"; // Default to mid-2024 for very old legacy items
    };

    // Mark deposit as paid if not in skip list and currently unpaid
    if (!shouldSkipDeposit && !shouldSkipFullAmount && order.depositStatus !== "paid" && order.depositAmt > 0) {
      updates.depositStatus = "paid";
      updates.depositPaid = getHistoricalDate(order.depositDue, order.poDate, order.created);
      hasUpdates = true;
    }

    // Mark release as paid if not in skip list and currently unpaid
    if (!shouldSkipRelease && !shouldSkipFullAmount && order.releaseStatus !== "paid" && order.releaseAmt > 0) {
      updates.releaseStatus = "paid";
      updates.releasePaid = getHistoricalDate(order.releaseDue, order.poDate, order.created);
      hasUpdates = true;
    }

    if (hasUpdates) {
      console.log(`✅ Updating ${order.ref}:`, updates);
      try {
        await fetch(`${API}/api/orders/${encodeURIComponent(order.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates)
        });
        updated++;
      } catch (e) {
        console.error(`❌ Failed to update ${order.ref}:`, e);
      }
    } else {
      skipped++;
    }
  }

  console.log(`\n✅ Done!`);
  console.log(`   Updated: ${updated} orders`);
  console.log(`   Skipped: ${skipped} orders (already paid or in unpaid list)`);
  console.log(`\nRefresh the page to see changes.`);
}

// Run it
bulkMarkPaid();
