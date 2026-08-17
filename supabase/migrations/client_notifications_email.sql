-- Préférence de notification email, par client.
--
-- Par défaut tout le monde reçoit les emails automatiques, comme aujourd'hui
-- — DEFAULT true préserve le comportement actuel pour les comptes existants
-- sans rien changer à leur insu.
--
-- Ne couvre QUE les emails automatiques liés au cycle de vie d'une commande
-- (accusé de réception, confirmation, changement de statut, livraison) —
-- c'est-à-dire sendOrderStatusEmail() dans src/lib/email.ts, seule fonction
-- qui envoie ce type de notification à un client. N'affecte ni les emails
-- que l'admin reçoit lui-même (alertes stock, récapitulatifs de commande,
-- nouveau compte en attente), ni l'email d'activation de compte, ni la
-- réinitialisation de mot de passe — ce dernier reste toujours envoyé,
-- transactionnel indispensable.

ALTER TABLE client_accounts
  ADD COLUMN IF NOT EXISTS notifications_email BOOLEAN NOT NULL DEFAULT true;
