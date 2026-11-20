/**
 * The check-in QR code. `qrCodeSvg` is made on the server with the `uqr`
 * library from the link alone (checkinQrCodeSvg): it holds only path data,
 * never text from a user, so it is safe to insert as markup. It is black on
 * white with its own quiet zone and fills the box `className` sizes.
 */
export function CheckinQrCode({
  qrCodeSvg,
  label,
  className,
}: {
  qrCodeSvg: string;
  /** "QR code for the check-in link …", in the chosen language. */
  label: string;
  className: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={`bg-white [&>svg]:block [&>svg]:size-full ${className}`}
      dangerouslySetInnerHTML={{ __html: qrCodeSvg }}
    />
  );
}
