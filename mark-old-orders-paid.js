// Mark all orders before December 1, 2025 as paid
const API_BASE = 'https://bureau-ops.pages.dev';

async function markOldOrdersPaid() {
  try {
    // Fetch all orders
    console.log('Fetching all orders...');
    const response = await fetch(`${API_BASE}/api/orders`);
    const orders = await response.json();

    console.log(`Found ${orders.length} total orders`);

    // Filter orders before Dec 1, 2025
    const cutoffDate = new Date('2025-12-01');
    const oldOrders = orders.filter(order => {
      const orderDate = new Date(order.createdAt || order.date);
      return orderDate < cutoffDate && order.paymentStatus !== 'paid';
    });

    console.log(`\nFound ${oldOrders.length} orders before Dec 1, 2025 that aren't marked as paid`);

    if (oldOrders.length === 0) {
      console.log('No orders to update!');
      return;
    }

    // Update each order
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
          console.log(`✓ ${order.id} - ${order.purchaseOrder || 'No PO'} marked as paid`);
        } else {
          failed++;
          console.error(`✗ ${order.id} - Failed: ${updateResponse.status}`);
        }
      } catch (err) {
        failed++;
        console.error(`✗ ${order.id} - Error: ${err.message}`);
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Updated: ${updated}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total: ${oldOrders.length}`);

  } catch (error) {
    console.error('Error:', error);
  }
}

markOldOrdersPaid();
