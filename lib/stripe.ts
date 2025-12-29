// lib/stripe.ts
import Stripe from 'stripe';

let stripeSingleton: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeSingleton) return stripeSingleton;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    // IMPORTANT: pas de throw à l'import => uniquement quand l'endpoint est appelé.
    throw new Error('Missing STRIPE_SECRET_KEY');
  }

  stripeSingleton = new Stripe(secretKey, {
    // Optionnel: apiVersion si tu la fixes globalement
    // apiVersion: '2024-06-20',
  });

  return stripeSingleton;
}
