import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { generateCataloguePDF, type CatalogueProductInput } from '../../../lib/pdf';
import { fetchPriceGroupOverrides, resolveGroupPrice } from '../../../lib/clients';
import { fetchProductImages } from '../../../lib/catalogueImages';
import { formatDateReunion } from '../../../lib/datetime';

// Middleware (src/middleware.ts) protège déjà tout /api/admin/* derrière
// isStaff — pas besoin de revérifier le rôle ici, même convention que les
// autres routes de ce dossier.

const CATEGORIES = ['boissons', 'snacks', 'chips', 'confiseries', 'divers'];
const CAT_LABEL: Record<string, string> = {
  boissons: 'Boissons', snacks: 'Snacks', chips: 'Chips', confiseries: 'Confiseries', divers: 'Divers',
};

export const GET: APIRoute = async ({ url }) => {
  const groupeParam = url.searchParams.get('groupe') ?? 'base';
  const hideUnavailable = url.searchParams.get('hide_unavailable') !== '0';
  const catsParam = url.searchParams.getAll('cat').filter(c => CATEGORIES.includes(c));
  // Aucune catégorie cochée retombe sur "toutes" plutôt que de générer un
  // catalogue vide — un formulaire mal soumis ne doit jamais produire un PDF
  // sans produits.
  const selectedCats = catsParam.length > 0 ? catsParam : CATEGORIES;

  let groupLabel = 'Prix de base';
  let groupId: string | null = null;
  if (groupeParam !== 'base') {
    const { data: group } = await supabaseAdmin
      .from('price_groups').select('id, name').eq('id', groupeParam).maybeSingle();
    if (group) { groupId = group.id; groupLabel = group.name; }
  }

  const { data: products } = await supabaseAdmin
    .from('products')
    .select('id, name, category, unit, units_per_carton, price_ht, in_stock, image_url')
    .in('category', selectedCats)
    .order('category', { ascending: true })
    .order('name', { ascending: true });

  const overrides = await fetchPriceGroupOverrides(groupId);

  const filtered = (products ?? []).filter(p => !hideUnavailable || p.in_stock);
  // Tri par ordre de catégorie métier (pas alphabétique), même convention que
  // /admin/produits, puis par nom — nécessaire pour que les intertitres du
  // PDF ne se répètent pas.
  const sorted = [...filtered].sort((a, b) => {
    const ca = CATEGORIES.indexOf(a.category), cb = CATEGORIES.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name, 'fr');
  });

  const images = await fetchProductImages(sorted.map(p => ({ id: p.id, imageUrl: p.image_url })));

  const catalogueProducts: CatalogueProductInput[] = sorted.map(p => ({
    id: p.id,
    name: p.name,
    category: p.category,
    categoryLabel: CAT_LABEL[p.category] ?? p.category,
    unit: p.unit,
    unitsPerCarton: p.units_per_carton,
    cartonPriceHt: resolveGroupPrice(p.id, p.price_ht, overrides),
    imageBuffer: images.get(p.id) ?? null,
  }));

  const editionDateLabel = formatDateReunion(new Date(), { day: 'numeric', month: 'long' });

  const buffer = await generateCataloguePDF({
    groupLabel,
    editionDateLabel,
    products: catalogueProducts,
  });

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="catalogue-inca-import.pdf"',
      'Content-Length': String(buffer.length),
    },
  });
};
