// Balisage schema.org (JSON-LD) pour les moteurs et les IA. Il est rendu
// publiquement : ne jamais y mettre un prix, une remise, un stock ni aucune
// donnée dépendante du client connecté.
import { COMPANY } from './constants';

/** Description par défaut du site : meta description ET JSON-LD Organization. */
export const SITE_DESCRIPTION =
  "Grossiste B2B à La Réunion pour stations-service et supérettes : boissons, snacks, confiseries. Livraison sous 48h dans l'Ouest (Saint-Paul, Saint-Gilles, Le Port, La Possession, Saint-Leu).";

const REUNION = { '@type': 'AdministrativeArea', name: 'La Réunion' };

// Zone de livraison actuelle (Ouest, 48h) — à garder alignée sur
// components/DeliveryZones.astro. Saint-Gilles est une localité de Saint-Paul,
// pas une commune : d'où le type Place.
const DELIVERY_AREA = [
  { '@type': 'City', name: 'Saint-Paul', containedInPlace: REUNION },
  { '@type': 'Place', name: 'Saint-Gilles', containedInPlace: { '@type': 'City', name: 'Saint-Paul' } },
  { '@type': 'City', name: 'Le Port', containedInPlace: REUNION },
  { '@type': 'City', name: 'La Possession', containedInPlace: REUNION },
  { '@type': 'City', name: 'Saint-Leu', containedInPlace: REUNION },
];

const ORG_ID = `${COMPANY.siteUrl}/#organization`;

export function organizationJsonLd(description: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'LocalBusiness',
        '@id': ORG_ID,
        name: COMPANY.name,
        legalName: 'INCA IMPORT',
        description,
        url: COMPANY.siteUrl,
        telephone: `+${COMPANY.phoneHref.replace(/^\+/, '')}`,
        email: COMPANY.contactEmail,
        identifier: { '@type': 'PropertyValue', propertyID: 'SIRET', value: COMPANY.siret },
        address: {
          '@type': 'PostalAddress',
          streetAddress: COMPANY.addressLine,
          postalCode: COMPANY.postalCode,
          addressLocality: COMPANY.city,
          addressRegion: COMPANY.region,
          addressCountry: 'RE',
        },
        areaServed: DELIVERY_AREA,
        knowsAbout: ['Grossiste B2B', 'Boissons', 'Snacks', 'Confiseries'],
        audience: { '@type': 'BusinessAudience', audienceType: 'Stations-service, supérettes et commerces professionnels' },
        availableLanguage: 'fr',
      },
      {
        '@type': 'WebSite',
        '@id': `${COMPANY.siteUrl}/#website`,
        url: COMPANY.siteUrl,
        name: COMPANY.name,
        inLanguage: 'fr',
        publisher: { '@id': ORG_ID },
      },
    ],
  };
}

/** Fiche produit SANS offre : l'absence d'`offers` est volontaire, les prix
 *  ne sont visibles qu'une fois connecté. */
export function productJsonLd(p: {
  name: string; slug: string; description: string | null; sku: string | null;
  categoryLabel: string | null; imageUrl: string | null;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    url: `${COMPANY.siteUrl}/catalogue/${p.slug}`,
    description: p.description ?? `${p.name} disponible chez Inca Import, grossiste B2B à La Réunion.`,
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.categoryLabel ? { category: p.categoryLabel } : {}),
    ...(p.imageUrl ? { image: p.imageUrl } : {}),
    audience: { '@type': 'BusinessAudience', audienceType: 'Professionnels (B2B)' },
  };
}

/** Sérialisation sûre pour un <script> : neutralise « < » (anti </script>). */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
