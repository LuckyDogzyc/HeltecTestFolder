import './globals.css';

export const metadata = {
  title: 'Pokémon Display Manager',
  description: 'Server WebUI for Pokémon e-paper displays',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
