"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleModels = exports.LocalModels = exports.OpenAIModels = void 0;
var OpenAIModels;
(function (OpenAIModels) {
    OpenAIModels["GPT_4O"] = "gpt-4o";
    OpenAIModels["GPT_4O_MINI"] = "gpt-4o-mini";
})(OpenAIModels || (exports.OpenAIModels = OpenAIModels = {}));
var LocalModels;
(function (LocalModels) {
    //LLAVA = "llava",
    LocalModels["LLAMA3_2_VISION"] = "llama3.2-vision";
})(LocalModels || (exports.LocalModels = LocalModels = {}));
var GoogleModels;
(function (GoogleModels) {
    GoogleModels["GEMINI_2_FLASH"] = "gemini-2.0-flash-001";
    GoogleModels["GEMINI_2_FLASH_LITE"] = "gemini-2.0-flash-lite-preview-02-05";
    GoogleModels["GEMINI_1_5_FLASH"] = "gemini-1.5-flash";
    GoogleModels["GEMINI_1_5_FLASH_8B"] = "gemini-1.5-flash-8b";
    GoogleModels["GEMINI_1_5_PRO"] = "gemini-1.5-pro";
})(GoogleModels || (exports.GoogleModels = GoogleModels = {}));
