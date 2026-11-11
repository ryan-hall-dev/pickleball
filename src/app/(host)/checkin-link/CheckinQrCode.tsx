/**
 * The check-in QR code. `qrCodeSvg` is made on the server with the `uqr`
 * library from the link alone (checkinQrCodeSvg): it holds only path data,
 * never text from a user, so it is safe to insert as markup. It is black on
 * white with its own quiet zone and fills the box `className` sizes.
 */
export function CheckinQrCode({
  qrCodeSvg,
  shortLink,
  className,
}: {
  qrCodeSvg: string;
  shortLink: string;
  className: string;
}) {
  return (
    <div
      role="img"
      aria-label={`QR code for the check-in link ${shortLink}`}
      className={`bg-white [&>svg]:block [&>svg]:size-full ${className}`}
      dangerouslySetInnerHTML={{ __html: qrCodeSvg }}
    />
  );
}
