"""Config flow for Room Intercom — single instance, no input required."""

from __future__ import annotations

from homeassistant.config_entries import ConfigFlow

from .const import DOMAIN


class RoomIntercomConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-step setup: nothing to configure, everything is runtime."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Room Intercom", data={})
        return self.async_show_form(step_id="user")
