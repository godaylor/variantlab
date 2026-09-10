import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { headers } from "next/headers";

export const metadata = baseMetaData;

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const nonce = (await headers()).get("x-nonce") ?? undefined;
	return (
		<html lang="ru" suppressHydrationWarning>
			<body className="font-sans antialiased">
				<ThemeProvider
					nonce={nonce}
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<TooltipProvider>
						<Toaster />
						{children}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
