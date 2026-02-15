// Fix paid dates for orders incorrectly marked as paid today
// Run this in browser console on bureau-a04.pages.dev

const API = "https://bureau.nik-d88.workers.dev";
const TODAY = "2026-02-15"; // The incorrect date from previous script

// List of genuinely unpaid items - skip these
const UNPAID_ITEMS = [
  { ref: "PO 196 (WeWork)", type: "Release" },
  { ref: "PO 197 (WeWork)", type: "Release" },
  { ref: "PO-191", type: "Release" },
  { ref: "PO-195 (WeWork)", type: "Release" },
  { ref: "PO-199", type: "Release" },
  { ref: "PO-204 (CISCO)", type: "Deposit" },
  { ref: "Thank You Cards", type: "Deposit" },
  { ref: "PO-189 (Treasure Data)", type: "Release" },
  { ref: "PO-201", type: "Release" },
  { ref: "PO-201", type: "Deposit" },
  { ref: "PO-203", type: "Release" },
  { ref: "PO-203", type: "Deposit" },
  { ref: "PO-206", type: "Release" },
  { ref: "PO-206", type: "Deposit" },
  { ref: "PO-212", type: "Release" },
  { ref: "PO-212", type: "Deposit" },
  { ref: "PO-213", type: "Release" },
  { ref: "PO-213", type: "Deposit" },
  { ref: "PO-214", type: "Release" },
  { ref: "PO-214", type: "Deposit" },
  { ref: "Silk Print, Photography", type: "Release" },
  { ref: "Tuesday V2 Doors (x6)", type: "Deposit" },
];

function getHistoricalDate(dueDate, poDate, created, isRelease) {
  // Use due date if available
  if (dueDate && dueDate !== TODAY) return dueDate;

  // Use PO date with offset if available
  if (poDate) {
    const d = new Date(poDate);
    // Add realistic delays: ~45 days for deposit, ~90 days for release
    d.setDate(d.getDate() + (isRelease ? 90 : 45));
    return d.toISOString().slice(0, 10);
  }

  // Use created date
  if (created) {
    const d = new Date(created);
    return d.toISOString().slice(0, 10);
  }

  // Default to mid-2024 for very old legacy items
  return "2024-06-01";
}

async function fixPaidDates() {
  console.log("🔄 Fetching all orders...");
  const res = await fetch(`${API}/api/orders`);
  const data = await res.json();
  const orders = data.orders;
  console.log(`📋 Found ${orders.length} orders`);

  let fixed = 0;
  let skipped = 0;

  for (const order of orders) {
    const updates = {};
    let hasUpdates = false;

    // Check if deposit was paid today (incorrectly)
    if (order.depositPaid === TODAY && order.depositStatus === "paid") {
      const shouldSkip = UNPAID_ITEMS.some(
        item => item.ref === order.ref && (item.type === "Deposit" || item.type === "Full Amount")
      );

      if (!shouldSkip) {
        updates.depositPaid = getHistoricalDate(order.depositDue, order.poDate, order.created, false);
        hasUpdates = true;
        console.log(`🔧 Fixing ${order.ref} deposit: ${TODAY} → ${updates.depositPaid}`);
      }
    }

    // Check if release was paid today (incorrectly)
    if (order.releasePaid === TODAY && order.releaseStatus === "paid") {
      const shouldSkip = UNPAID_ITEMS.some(
        item => item.ref === order.ref && (item.type === "Release" || item.type === "Full Amount")
      );

      if (!shouldSkip) {
        updates.releasePaid = getHistoricalDate(order.releaseDue, order.poDate, order.created, true);
        hasUpdates = true;
        console.log(`🔧 Fixing ${order.ref} release: ${TODAY} → ${updates.releasePaid}`);
      }
    }

    if (hasUpdates) {
      try {
        await fetch(`${API}/api/orders/${encodeURIComponent(order.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates)
        });
        fixed++;
      } catch (e) {
        console.error(`❌ Failed to update ${order.ref}:`, e);
      }
    } else {
      skipped++;
    }
  }

  console.log(`\n✅ Done!`);
  console.log(`   Fixed: ${fixed} orders`);
  console.log(`   Skipped: ${skipped} orders (correct dates or genuinely unpaid)`);
  console.log(`\nRefresh the page to see historical dates.`);
}

// Run it
fixPaidDates();
