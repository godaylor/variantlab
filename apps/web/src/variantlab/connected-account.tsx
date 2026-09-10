"use client";

import { useState, type FormEvent } from "react";
import { signIn, signOut, signUp, useSession } from "@/auth/client";
import { useVariantLabLocale } from "./locale";

export function ConnectedAccount() {
	const { t } = useVariantLabLocale();
	const { data: session, isPending, refetch } = useSession();
	const [register, setRegister] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		const email = String(data.get("email") ?? "");
		const password = String(data.get("password") ?? "");
		setBusy(true);
		setFailed(false);
		try {
			const result = register
				? await signUp.email({ email, password, name: String(data.get("name") ?? "") })
				: await signIn.email({ email, password });
			if (result.error) setFailed(true);
			else await refetch();
		} catch { setFailed(true); }
		finally { setBusy(false); }
	}

	return <section aria-labelledby="connected-account-title" className="border-b-2 border-[#172128] p-5">
		<h3 id="connected-account-title" className="font-bold">{t({ ru: "Подключённый аккаунт", en: "Connected account" })}</h3>
		{isPending ? <p role="status">{t({ ru: "Проверка входа…", en: "Checking session…" })}</p> : session ? <div className="mt-2 flex items-center gap-3">
			<p>{t({ ru: "Вход выполнен:", en: "Signed in:" })} <span translate="no">{session.user.name}</span></p>
			<button type="button" className="border-2 border-[#172128] px-3 py-2" onClick={() => { void signOut().then(() => refetch()).catch(() => setFailed(true)); }}>{t({ ru: "Выйти", en: "Sign out" })}</button>
		</div> : <form onSubmit={(event) => void submit(event)} className="mt-3 grid max-w-lg gap-3">
			<p className="text-sm">{t({ ru: "Аккаунт нужен только для облачной загрузки. Локальный монтаж доступен без входа.", en: "An account is required only for cloud uploads. Local editing needs no sign-in." })}</p>
			{register ? <label>{t({ ru: "Имя", en: "Name" })}<input name="name" autoComplete="name" required maxLength={100} className="block w-full border-2 border-[#172128] bg-white p-2" /></label> : null}
			<label>{t({ ru: "Электронная почта", en: "Email" })}<input name="email" type="email" autoComplete="email" required maxLength={254} className="block w-full border-2 border-[#172128] bg-white p-2" /></label>
			<label>{t({ ru: "Пароль", en: "Password" })}<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={8} maxLength={128} className="block w-full border-2 border-[#172128] bg-white p-2" /></label>
			<div className="flex flex-wrap gap-3"><button type="submit" disabled={busy} className="border-2 border-[#172128] bg-[#194f78] px-3 py-2 font-bold text-white disabled:opacity-50">{busy ? t({ ru: "Подождите…", en: "Please wait…" }) : register ? t({ ru: "Создать аккаунт", en: "Create account" }) : t({ ru: "Войти", en: "Sign in" })}</button><button type="button" onClick={() => { setRegister((value) => !value); setFailed(false); }} className="border-2 border-[#172128] px-3 py-2">{register ? t({ ru: "Уже есть аккаунт", en: "Already have an account" }) : t({ ru: "Регистрация", en: "Register" })}</button></div>
		</form>}
		{failed ? <p role="alert" className="mt-3 text-[#8f281a]">{t({ ru: "Вход не выполнен. Проверьте данные и доступность сервера; если попыток много, подождите минуту.", en: "Sign-in failed. Check your details and server availability; after many attempts, wait a minute." })}</p> : null}
	</section>;
}
