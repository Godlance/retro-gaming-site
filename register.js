"use strict";

document.addEventListener("DOMContentLoaded", function() {
    const form = document.getElementById("registration_form");
    const submitButton = document.getElementById("registration_submit");
    const status = document.getElementById("registration_status");

    form.addEventListener("submit", async function(event) {
        event.preventDefault();
        status.className = "registration-status";

        if (!form.reportValidity()) return;

        const payload = {
            username: form.elements.username.value,
            password: form.elements.password.value,
            confirmPassword: form.elements.confirmPassword.value
        };

        if (payload.password !== payload.confirmPassword) {
            status.textContent = "The two passwords do not match.";
            status.classList.add("is-error");
            return;
        }

        submitButton.disabled = true;
        status.textContent = "Creating account…";

        try {
            const response = await fetch("/api/maplestory/accounts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(function() {
                return { message: "The registration service returned an invalid response." };
            });

            if (!response.ok) throw new Error(result.message || "Account registration failed.");

            form.reset();
            status.textContent = result.message;
            status.classList.add("is-success");
        } catch (error) {
            status.textContent = error.message || "Account registration failed.";
            status.classList.add("is-error");
        } finally {
            submitButton.disabled = false;
        }
    });
});
