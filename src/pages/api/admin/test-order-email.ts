import type { APIRoute } from 'astro';
import { sendOrderStatusEmail } from '../../../lib/email';

// Temporary endpoint — delete after testing
export const GET: APIRoute = async ({ url }) => {
  const status = url.searchParams.get('status') ?? 'expediee';

  await sendOrderStatusEmail({
    to: 'inca-import@hotmail.com',
    orderId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    status,
    orderDate: new Date('2026-06-17T10:45:00'),
    items: [
      { name: "Thon albacore à l'huile", quantity: 12, unit: 'Carton de 24 × 185 g' },
      { name: 'Lentilles vertes du Puy', quantity: 6,  unit: 'Carton de 12 × 500 g' },
      { name: 'Riz basmati premium',     quantity: 24, unit: 'Carton de 10 × 1 kg'  },
    ],
    totalHt: 487.50,
  });

  return new Response(
    JSON.stringify({ result: 'SENT ✅', to: 'inca-import@hotmail.com', status }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
};
