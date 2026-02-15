// ===================================================
// BROWSER CONSOLE SCRIPT
// Mark all orders before December 1, 2025 as paid
// ===================================================
//
// HOW TO USE:
// 1. Open your dashboard: https://bureau-ops.pages.dev
// 2. Open browser console (F12 or Cmd+Option+J on Mac)
// 3. Copy this entire script
// 4. Paste into console and press Enter
//
// ===================================================

(async function markOldOrdersPaid() {
  const API_BASE = 'https://bureau-ops.pages.dev';
  const cutoffDate = new Date('2025-12-01');

  console.log('🔍 Fetching all orders...');

  try {
    const response = await fetch(`${API_BASE}/api/orders`);
    const orders = await response.json();

    console.log(`📦 Found ${orders.length} total orders`);

    // Filter orders before Dec 1, 2025 that aren't paid
    const oldOrders = orders.filter(order => {
      const orderDate = new Date(order.createdAt || order.date);
      return orderDate < cutoffDate && order.paymentStatus !== 'paid';
    });

    console.log(`\n📅 Found ${oldOrders.length} orders before Dec 1, 2025 to mark as paid:`);

    if (oldOrders.length === 0) {
      console.log('✅ All old orders are already marked as paid!');
      return;
    }

    // Show which orders will be updated
    console.table(oldOrders.map(o => ({
      ID: o.id,
      PO: o.purchaseOrder || 'No PO',
      Date: new Date(o.createdAt || o.date).toLocaleDateString(),
      Status: o.paymentStatus
    })));

    const confirm = window.confirm(
      `Mark ${oldOrders.length} orders as PAID?\n\n` +
      `This will update all orders created before December 1, 2025.\n\n` +
      `Click OK to proceed.`
    );

    if (!confirm) {
      console.log('❌ Cancelled by user');
      return;
    }

    console.log('\n🔄 Updating orders...');

    let updated = 0;
    let failed = 0;

    for (const order of oldOrders) {
      try {
        const updateResponse = await fetch(`${API_BASE}/api/orders/${order.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...order,
            paymentStatus: 'paid'
          })
        });

        if (updateResponse.ok) {
          updated++;
          console.log(`✓ ${order.id} - ${order.purchaseOrder || 'No PO'}`);
        } else {
          failed++;
          const error = await updateResponse.text();
          console.error(`✗ ${order.id} - Failed: ${updateResponse.status} - ${error}`);
        }
      } catch (err) {
        failed++;
        console.error(`✗ ${order.id} - Error: ${err.message}`);
      }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log('📊 SUMMARY');
    console.log(`${'='.repeat(50)}`);
    console.log(`✅ Updated: ${updated}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📦 Total: ${oldOrders.length}`);
    console.log(`${'='.repeat(50)}`);

    alert(`Done! Updated ${updated} orders.\n${failed > 0 ? `Failed: ${failed}` : 'All successful!'}`);

  } catch (error) {
    console.error('❌ Error:', error);
    alert(`Error: ${error.message}`);
  }
})();
