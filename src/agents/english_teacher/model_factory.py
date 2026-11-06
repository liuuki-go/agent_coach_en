from langchain_ollama import ChatOllama
from config.config_anasize import get_config_value


_model: ChatOllama | None = None

def build_model(model_name: str,base_url: str,temperature: float=0,switch_model: bool=False)-> ChatOllama:
    global _model

    if _model is None or switch_model:
        _model = ChatOllama(
            model=model_name,
            base_url=base_url,
            temperature=temperature,
        )
    return _model


def get_model(model_name: str,base_url: str,temperature: float,switch_model: bool=False)-> ChatOllama:
    # If the model is not initialized or if switch_model is True, create a new instance of ChatOllama
    if _model is None or switch_model:
        #validate the parameters before creating the model
        if not model_name or not base_url :
            # use default values or raise an error
            model_name = get_config_value("MODEL_CONFIG", "")
            base_url = get_config_value("MODEL_CONFIG", "base_url")
            if not model_name or not base_url:
                raise ValueError("Please configure the model's informations in sys_config.yaml ")

            return build_model(model_name, base_url, temperature, switch_model)

        return build_model(model_name,base_url,temperature,switch_model) 
       
    return _model
