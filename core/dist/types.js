"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleModels = exports.LocalModels = exports.OpenAIModels = void 0;
var OpenAIModels;
(function (OpenAIModels) {
    OpenAIModels["GPT_4O"] = "gpt-4o";
    OpenAIModels["GPT_4O_MINI"] = "gpt-4o-mini";
    OpenAIModels["GPT_4_1"] = "gpt-4.1";
    OpenAIModels["GPT_4_1_MINI"] = "gpt-4.1-mini";
})(OpenAIModels || (exports.OpenAIModels = OpenAIModels = {}));
var LocalModels;
(function (LocalModels) {
    //LLAVA = "llava",
    LocalModels["LLAMA3_2_VISION"] = "llama3.2-vision";
})(LocalModels || (exports.LocalModels = LocalModels = {}));
var GoogleModels;
(function (GoogleModels) {
    GoogleModels["GEMINI_4_ARGON"] = "gemini-4-argon";
    GoogleModels["GEMINI_3_8_FLASH"] = "gemini-3.8-flash";
    GoogleModels["GEMINI_3_6_FLASH"] = "gemini-3.6-flash";
    GoogleModels["GEMINI_3_5_FLASH_LITE"] = "gemini-3.5-flash-lite";
    GoogleModels["GEMINI_3_1_FLASH_LITE"] = "gemini-3.1-flash-lite";
    GoogleModels["GEMINI_3_1_PRO"] = "gemini-3.1-pro-preview";
    GoogleModels["GEMINI_3_FLASH"] = "gemini-3-flash-preview";
    GoogleModels["GEMINI_FLASH_LATEST"] = "gemini-flash-latest";
    GoogleModels["GEMINI_2_5_FLASH"] = "gemini-2.5-flash";
    GoogleModels["GEMINI_2_5_FLASH_LITE"] = "gemini-2.5-flash-lite";
    GoogleModels["GEMINI_2_5_PRO"] = "gemini-2.5-pro";
})(GoogleModels || (exports.GoogleModels = GoogleModels = {}));
